'use strict';
// Personal access tokens for the public API (see routes/v1.js, migration 0021).
//
// A token is `depot_` followed by 32 random bytes in base64url. Only its SHA-256 is kept;
// the token itself goes back to the person exactly once, when it is made. It acts as that
// person, held to the scope chosen for it: read (look and download), write (read plus add,
// change and delete files), admin (write plus what the Admin page can do; admins only).
// Viewers cannot make tokens. An expiry is optional; a revoked or expired token is refused.
const crypto = require('crypto');
const db = require('./db');

const PREFIX = 'depot_';
const SCOPES = ['read', 'write', 'admin'];
const SCOPE_RANK = { read: 1, write: 2, admin: 3 };
const NAME_MAX = 80;
const MAX_PER_USER = 50;

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const generate = () => PREFIX + crypto.randomBytes(32).toString('base64url');
const looksLikeToken = (s) => typeof s === 'string' && s.startsWith(PREFIX) && s.length >= PREFIX.length + 40 && s.length <= 120;

// The scope a request effectively has: the token's, or for an ordinary sign-in the most
// the person's role allows.
function effectiveScope(user, apiToken) {
  if (apiToken) return apiToken.scope;
  if (!user) return null;
  return user.role === 'admin' ? 'admin' : user.role === 'contributor' ? 'write' : 'read';
}
function scopeCovers(have, need) { return !!have && !!need && SCOPE_RANK[have] >= SCOPE_RANK[need]; }

const publicShape = (r) => ({
  id: r.id, name: r.name, prefix: r.token_prefix, scope: r.scope,
  created_at: r.created_at, expires_at: r.expires_at, last_used_at: r.last_used_at, revoked_at: r.revoked_at,
  ...(r.user_email !== undefined ? { user_id: r.user_id, user_email: r.user_email } : {}),
});

// Make a token for `user`. Returns { token, record }; the token is never stored.
async function create({ user, name, scope, expiresAt }) {
  if (!user?.id) throw httpError(401, 'Sign in first');
  if (user.role === 'viewer') throw httpError(403, 'Viewers cannot make API tokens');
  const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
  if (!cleanName) throw httpError(400, 'Give the token a name, such as the script or computer that will use it');
  if (cleanName.length > NAME_MAX) throw httpError(400, `Keep the name under ${NAME_MAX} characters`);
  if (!SCOPES.includes(scope)) throw httpError(400, 'scope must be read, write or admin');
  if (scope === 'admin' && user.role !== 'admin') throw httpError(403, 'Only an administrator can make an admin token');
  let expires = null;
  if (expiresAt != null && expiresAt !== '') {
    expires = new Date(expiresAt);
    if (isNaN(expires)) throw httpError(400, 'expires_at must be a date');
    if (expires.getTime() <= Date.now()) throw httpError(400, 'expires_at must be in the future');
  }
  const live = await db.queryOne('SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
  if ((live?.n || 0) >= MAX_PER_USER) throw httpError(400, `You already have ${MAX_PER_USER} tokens. Revoke one you no longer use first`);
  const token = generate();
  const record = await db.queryOne(
    `INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, scope, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, name, token_prefix, scope, created_at, expires_at, last_used_at, revoked_at`,
    [user.id, cleanName, hash(token), token.slice(0, PREFIX.length + 6), scope, expires]);
  return { token, record: publicShape(record) };
}

async function listFor(userId) {
  const rows = await db.query(
    `SELECT id, user_id, name, token_prefix, scope, created_at, expires_at, last_used_at, revoked_at
       FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`, [userId]);
  return rows.map(publicShape);
}

// Every live token in the workspace, for an administrator.
async function listAll() {
  const rows = await db.query(
    `SELECT t.id, t.user_id, t.name, t.token_prefix, t.scope, t.created_at, t.expires_at, t.last_used_at, t.revoked_at,
            u.email AS user_email
       FROM api_tokens t LEFT JOIN user_roles u ON u.user_id = t.user_id
      WHERE t.revoked_at IS NULL ORDER BY t.created_at DESC`);
  return rows.map(publicShape);
}

// Revoke one of the caller's own tokens, or (an administrator) anyone's.
async function revoke(id, { byUser, anyUser = false }) {
  if (!isUuid(id)) return null;
  const row = await db.queryOne(
    `UPDATE api_tokens SET revoked_at = NOW(), revoked_by = $2
      WHERE id = $1 AND revoked_at IS NULL ${anyUser ? '' : 'AND user_id = $2'}
      RETURNING id, user_id, name, token_prefix, scope, created_at, expires_at, last_used_at, revoked_at`,
    [id, byUser.id]);
  return row ? publicShape(row) : null;
}

// The record for a presented token, or null when it is unknown, revoked or expired.
async function authenticate(token) {
  if (!looksLikeToken(token)) return null;
  const row = await db.queryOne(
    `SELECT id, user_id, name, scope, expires_at FROM api_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`, [hash(token)]);
  return row || null;
}

// "Last used", written at most once a minute per token so a busy script is not a write
// per request.
async function touch(id) {
  try {
    await db.query(
      `UPDATE api_tokens SET last_used_at = NOW()
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - interval '1 minute')`, [id]);
  } catch { /* best effort */ }
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

module.exports = { PREFIX, SCOPES, SCOPE_RANK, NAME_MAX, MAX_PER_USER, generate, hash, looksLikeToken, effectiveScope, scopeCovers, create, listFor, listAll, revoke, authenticate, touch, publicShape };
