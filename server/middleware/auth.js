'use strict';
const jwt = require('jsonwebtoken');
const { JwksClient } = require('jwks-rsa');
const db = require('../lib/db');

let _jwksClient;
function jwks() {
  if (!_jwksClient) {
    const base = process.env.KEYCLOAK_INTERNAL_URL || process.env.KEYCLOAK_URL;
    const realm = process.env.KEYCLOAK_REALM || 'memex';
    _jwksClient = new JwksClient({
      jwksUri: `${base}/realms/${realm}/protocol/openid-connect/certs`,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 10 * 60 * 1000,
    });
  }
  return _jwksClient;
}

async function verifyToken(token) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded?.header?.kid) throw new Error('Invalid token structure');
  const key = await jwks().getSigningKey(decoded.header.kid);
  return jwt.verify(token, key.getPublicKey(), { algorithms: ['RS256'] });
}

// Keycloak puts email_verified in the token through the realm's default "email"
// client scope. Anything other than a real boolean is treated as "not said".
function emailVerifiedClaim(payload) {
  if (payload?.email_verified === true) return true;
  if (payload?.email_verified === false) return false;
  return null;
}

// A token with no email_verified claim means shares will not match that account. Say so
// once per account per process, so a misconfigured realm shows up in the logs without
// flooding them.
const _warnedMissingClaim = new Set();
function noteMissingClaim(userId) {
  if (_warnedMissingClaim.has(userId) || _warnedMissingClaim.size > 10000) return;
  _warnedMissingClaim.add(userId);
  console.warn(`auth: token for user ${userId} carries no email_verified claim; address-keyed shares will not match it`);
}

module.exports = async function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let payload;
  try {
    payload = await verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const userId = payload.sub;
  const userEmail = (payload.email || '').toLowerCase();
  // Whether the identity provider vouches for the address: true, false, or null when
  // the token says nothing. Only a verified address may match an address-keyed share,
  // so an account that merely claims someone else's address inherits nothing of theirs.
  const emailVerified = emailVerifiedClaim(payload);
  const verifiedEmail = emailVerified === true && userEmail ? userEmail : null;

  let roleRow = await db.queryOne('SELECT role, verified_email FROM user_roles WHERE user_id = $1', [userId]);

  if (!roleRow) {
    // ADMIN_EMAILS bootstraps the first admin by address, so it must be an address the
    // identity provider has verified — otherwise anyone able to put that address on an
    // unverified account would be made an admin on first sign-in. The seeded install
    // admin is created verified (keycloak/memex-realm.json).
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    const assignedRole = verifiedEmail && adminEmails.includes(verifiedEmail) ? 'admin' : 'contributor';
    roleRow = await db.queryOne(
      `INSERT INTO user_roles (user_id, email, role, verified_email, email_verified_at)
       VALUES ($1, $2, $3, $4::text, CASE WHEN $4::text IS NULL THEN NULL ELSE NOW() END)
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING role, verified_email`,
      [userId, userEmail, assignedRole, verifiedEmail]
    ) ?? { role: assignedRole, verified_email: verifiedEmail };
    // Auto-provisioning assigns a role with no human approval, so record it in the
    // tamper-evident chain. Best-effort and fire-and-forget: auditing must never
    // block or fail authentication.
    require('../lib/auditLog').append({
      eventType: 'user_provisioned', actorId: userId, actorEmail: userEmail,
      detail: `auto-assigned role ${assignedRole}`,
    }).catch(() => {});
  }

  // Keep the stored verified address in step with the latest token. Written only when
  // it actually changes, so an ordinary request never writes; conditional, so parallel
  // requests with the same token settle on the same value.
  if ((roleRow.verified_email || null) !== verifiedEmail) {
    try {
      await db.query(
        `UPDATE user_roles SET verified_email = $2::text,
                email_verified_at = CASE WHEN $2::text IS NULL THEN NULL ELSE NOW() END
          WHERE user_id = $1 AND verified_email IS DISTINCT FROM $2::text`,
        [userId, verifiedEmail]
      );
    } catch (e) { console.error('auth: recording verified email failed:', e.message); }
  }
  if (emailVerified === null) noteMissingClaim(userId);

  req.user = {
    id: userId,
    email: userEmail,
    emailVerified,
    verifiedEmail,
    role: roleRow.role,
    user_metadata: { full_name: payload.name },
    idp_avatar: payload.picture || null, // 365/Google profile picture, when the IdP provides it
  };

  next();
};

// Reused by the WebSocket signaling server (which can't run Express middleware).
module.exports.verifyToken = verifyToken;
module.exports.emailVerifiedClaim = emailVerifiedClaim;
