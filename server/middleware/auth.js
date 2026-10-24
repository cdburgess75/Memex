'use strict';
const jwt = require('jsonwebtoken');
const { JwksClient } = require('jwks-rsa');
const db = require('../lib/db');
const apiTokens = require('../lib/apiTokens');
const requestContext = require('../lib/requestContext');

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

// Say once per account per process when a token does not vouch for its address, so a
// misconfigured realm or an account created without "Email verified" shows up in the
// logs without flooding them.
//  - No claim at all: the realm is not sending it (the client lost its "email" scope).
//    The address is never treated as verified: nothing shared to it opens for this
//    account, and it cannot bootstrap an admin.
//  - Claim false: Keycloak says the address is unverified. Files shared to that address
//    will not open for this account until "Email verified" is ticked for it.
//  - An ADMIN_EMAILS address that is not verified is not made an admin.
const _warnedUnverified = new Set();
function noteUnverified(userId, email, claim) {
  const key = `${userId}:${claim}`;
  if (_warnedUnverified.has(key) || _warnedUnverified.size > 10000) return;
  _warnedUnverified.add(key);
  if (claim === 'admin') {
    console.warn(`auth: ${JSON.stringify(email)} is listed in ADMIN_EMAILS but Keycloak does not mark it verified, so it is not made an admin; tick "Email verified" for the account in Keycloak and sign in again`);
  } else if (claim === null) {
    console.warn(`auth: token for user ${userId} carries no email_verified claim; its address is not treated as verified, so files shared to it will not open (check the client's "email" scope in Keycloak)`);
  } else {
    console.warn(`auth: Keycloak marks the address ${JSON.stringify(email)} of user ${userId} unverified; files shared to that address will not open for it until "Email verified" is ticked for the account in Keycloak`);
  }
}

// The drive (routes/dav.js): reached by programs that can only send a username and a
// password, so there the password is an API token and the username is not used.
const onDrive = (req) => /^\/dav(\/|$|\?)/.test(String(req.originalUrl || ''));

// A personal access token (lib/apiTokens) in place of a sign-in. It acts as the person
// who made it and is accepted by the public API and the drive only: the app's own routes
// keep the sign-in, except when one of those hands a request on to them (routes/v1.js
// forward, routes/dav.js ask), which they mark.
async function authWithApiToken(token, req, res, next) {
  const t = await apiTokens.authenticate(token);
  if (!t) return res.status(401).json({ error: 'Invalid or expired token' });
  if (!req._v1Forward && !String(req.originalUrl || '').startsWith('/api/v1') && !onDrive(req)) {
    return res.status(403).json({ error: 'API tokens work with the /api/v1 endpoints and the drive (/dav) only' });
  }
  const roleRow = await db.queryOne('SELECT email, role, verified_email, disabled_at FROM user_roles WHERE user_id = $1', [t.user_id]);
  if (!roleRow) return res.status(401).json({ error: 'Invalid or expired token' });
  if (roleRow.disabled_at) {
    return res.status(403).json({ code: 'ACCOUNT_DISABLED', error: 'This account has been switched off. Ask an administrator if you think that is wrong.' });
  }
  // Tokens reach the public API and the drive; both are the license's `api` feature.
  const enforce = require('../lib/licenseEnforce');
  if (!(await enforce.feature('api'))) return enforce.refuseFeature(res, 'The API');
  apiTokens.touch(t.id);
  req.apiToken = { id: t.id, name: t.name, scope: t.scope, expires_at: t.expires_at || null };
  req.user = {
    id: t.user_id,
    email: String(roleRow.email || '').toLowerCase(),
    emailVerified: !!roleRow.verified_email,
    verifiedEmail: roleRow.verified_email || null,
    role: roleRow.role,
    user_metadata: {},
    idp_avatar: null,
  };
  // Everything this request does runs inside this context, so audit entries say which
  // token acted (lib/requestContext).
  return requestContext.run({ apiToken: req.apiToken }, () => next());
}

module.exports = async function auth(req, res, next) {
  // Already authenticated by the public API and handed on to one of the app's routes.
  if (req.user && req._v1Forward) return next();
  const header = String(req.headers.authorization || '');
  let token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!token && /^Basic /i.test(header) && onDrive(req)) {
    const pair = Buffer.from(header.slice('Basic '.length).trim(), 'base64').toString('utf8');
    token = pair.slice(pair.indexOf(':') + 1);
  }
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  if (apiTokens.looksLikeToken(token)) return authWithApiToken(token, req, res, next);

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

  // has_personal: whether they have a library of their own yet (see below). On the
  // partial unique index, so asking with every request costs next to nothing.
  let roleRow = await db.queryOne(
    `SELECT role, verified_email, disabled_at,
            EXISTS (SELECT 1 FROM libraries l WHERE l.owner_id = user_roles.user_id AND l.personal) AS has_personal
       FROM user_roles WHERE user_id = $1`,
    [userId]
  );

  /* Switched off: refused here, before anything else happens.
   *
   * Before the provisioning branch below, deliberately -- a disabled account must not get
   * a role row rewritten, a personal library made, or its verified address recorded, all
   * of which would quietly undo the switch. The identity provider is what stops a
   * sign-in; this is what stops a token that was issued before somebody left, or one from
   * a session still open somewhere.
   */
  if (roleRow?.disabled_at) {
    return res.status(403).json({
      code: 'ACCOUNT_DISABLED',
      error: 'This account has been switched off. Ask an administrator if you think that is wrong.',
    });
  }

  // ADMIN_EMAILS bootstraps the first admin by address, so it must be an address the
  // identity provider has verified — otherwise anyone able to put that address on an
  // unverified account would be made an admin on first sign-in. The seeded install
  // admin is created verified (keycloak/memex-realm.json).
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  const listedAdmin = !!userEmail && adminEmails.includes(userEmail);
  if (listedAdmin && !verifiedEmail) noteUnverified(userId, userEmail, 'admin');

  if (!roleRow) {
    // One more account? The license may say no: a lapsed term, a bad file, a hard seat
    // cap (lib/licenseEnforce). Refused before anything is written.
    const admit = await require('../lib/licenseEnforce').admitNewAccount();
    if (!admit.ok) return res.status(403).json({ code: admit.code, error: admit.error });
    const assignedRole = verifiedEmail && listedAdmin ? 'admin' : 'contributor';
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
  } else if (roleRow.role === 'contributor' && verifiedEmail && listedAdmin) {
    // The account was first seen before its address was verified, so it was made a
    // contributor. If the install still has no admin at all, the bootstrap never
    // happened: finish it now. Once any admin exists, roles are theirs to manage.
    try {
      const promoted = await db.queryOne(
        `UPDATE user_roles SET role = 'admin'
          WHERE user_id = $1 AND role = 'contributor'
            AND NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin')
          RETURNING role`,
        [userId]
      );
      if (promoted) {
        roleRow = { ...roleRow, role: promoted.role };
        require('../lib/auditLog').append({
          eventType: 'user_provisioned', actorId: userId, actorEmail: userEmail,
          detail: 'bootstrap admin from ADMIN_EMAILS once the address was verified',
        }).catch(() => {});
      }
    } catch (e) { console.error('auth: admin bootstrap failed:', e.message); }
  }

  /* Somewhere of their own, from the first moment they can add files: anything they upload
   * without saying where lands in it, so nothing is ever shared with anybody by forgetting
   * to choose.
   *
   * Not only on a first sign-in. Somebody who arrived as a viewer and was made a
   * contributor, or who was given a role by an administrator before they ever signed in,
   * reaches here with a role row and no library. Awaited, so the request that follows lands
   * in it rather than in the install's shared default; conditional on a unique index, so
   * two requests racing make one library. Best-effort: a person who cannot be given one is
   * not a person who should be refused entry.
   */
  if (roleRow.role !== 'viewer' && !roleRow.has_personal) {
    try {
      const owner = { id: userId, email: userEmail, role: roleRow.role };
      const lib = await require('../lib/libraries').ensurePersonalLibrary(owner, payload?.name || payload?.given_name || null);
      // A library made just now (ensurePersonalLibrary returns a row only then) gets the
      // getting-started guide in it, so the first thing they find is how to use the place.
      // Not awaited: copying the guide is not something a request should wait on.
      if (lib?.id) {
        require('../lib/gettingStarted').seedLibrary(lib.id, owner)
          .catch((e) => console.error('auth: could not add the getting-started guide:', e.message));
      }
    } catch (e) { console.error('auth: could not make a personal library:', e.message); }
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
  if (emailVerified !== true) noteUnverified(userId, userEmail, emailVerified);

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
