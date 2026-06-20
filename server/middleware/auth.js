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

  let roleRow = await db.queryOne('SELECT role FROM user_roles WHERE user_id = $1', [userId]);

  if (!roleRow) {
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    const assignedRole = adminEmails.includes(userEmail) ? 'admin' : 'contributor';
    roleRow = await db.queryOne(
      `INSERT INTO user_roles (user_id, email, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING role`,
      [userId, userEmail, assignedRole]
    ) ?? { role: assignedRole };
  }

  req.user = {
    id: userId,
    email: userEmail,
    role: roleRow.role,
    user_metadata: { full_name: payload.name },
    idp_avatar: payload.picture || null, // 365/Google profile picture, when the IdP provides it
  };

  next();
};

// Reused by the WebSocket signaling server (which can't run Express middleware).
module.exports.verifyToken = verifyToken;
