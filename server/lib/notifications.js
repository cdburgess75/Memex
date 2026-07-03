'use strict';
// In-app notifications. Recipients are matched by user_id OR email (a recipient
// may be notified before they've ever logged in / have a user_id). Idempotent
// runtime migration, same pattern as lib/profiles.js.
const db = require('./db');
const profiles = require('./profiles');

let ensured = false;

async function ensureTable() {
  if (ensured) return;
  await profiles.ensureProfiles(); // the opt-out pref lives on user_profiles
  await db.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID,
      user_email  TEXT,
      type        TEXT        NOT NULL,
      title       TEXT        NOT NULL,
      body        TEXT,
      ref_type    TEXT,
      ref_id      TEXT,
      read_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS notifications_email_idx ON notifications (lower(user_email), created_at DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC)');
  await db.query('ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE');
  ensured = true;
}

// Recipient match against the current user (id OR email). $startIndex = user_id,
// $startIndex+1 = email.
function recipientClause(startIndex) {
  return `(user_id = $${startIndex} OR lower(user_email) = lower($${startIndex + 1}))`;
}

// A recipient has notifications on unless they explicitly opted out. Missing
// profile row / null column ⇒ enabled.
async function enabledForEmail(email) {
  if (!email) return true;
  const row = await db.queryOne(
    'SELECT notifications_enabled FROM user_profiles WHERE lower(email) = lower($1)', [email]
  );
  return row ? row.notifications_enabled !== false : true;
}

// Create a notification for a recipient identified by email (and/or user_id).
// No-op (returns null) when the recipient has opted out.
async function create({ userId = null, userEmail = null, type, title, body = null, refType = null, refId = null }) {
  await ensureTable();
  const email = userEmail ? String(userEmail).toLowerCase() : null;
  if (!(await enabledForEmail(email))) return null;
  return db.queryOne(
    `INSERT INTO notifications (user_id, user_email, type, title, body, ref_type, ref_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, user_id, user_email, type, title, body, ref_type, ref_id, read_at, created_at`,
    [userId, email, type, title, body, refType, refId]
  );
}

async function listForUser(user, limit = 50) {
  await ensureTable();
  const cap = Math.max(1, Math.min(100, limit));
  return db.query(
    `SELECT id, type, title, body, ref_type, ref_id, read_at, created_at
     FROM notifications
     WHERE ${recipientClause(1)}
     ORDER BY created_at DESC
     LIMIT ${cap}`,
    [user.id || null, user.email || '']
  );
}

async function unreadCount(user) {
  await ensureTable();
  const row = await db.queryOne(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE ${recipientClause(1)} AND read_at IS NULL`,
    [user.id || null, user.email || '']
  );
  return row ? Number(row.n) : 0;
}

async function markRead(user, ids) {
  await ensureTable();
  if (!Array.isArray(ids) || !ids.length) return 0;
  const rows = await db.query(
    `UPDATE notifications SET read_at = NOW()
     WHERE ${recipientClause(2)} AND id = ANY($1::uuid[]) AND read_at IS NULL
     RETURNING id`,
    [ids.map(String), user.id || null, user.email || '']
  );
  return rows.length;
}

async function markAllRead(user) {
  await ensureTable();
  const rows = await db.query(
    `UPDATE notifications SET read_at = NOW()
     WHERE ${recipientClause(1)} AND read_at IS NULL RETURNING id`,
    [user.id || null, user.email || '']
  );
  return rows.length;
}

async function getPref(user) {
  await ensureTable();
  if (!user?.id) return true;
  const row = await db.queryOne('SELECT notifications_enabled FROM user_profiles WHERE user_id = $1', [user.id]);
  return row ? row.notifications_enabled !== false : true;
}

async function setPref(user, enabled) {
  await ensureTable();
  await profiles.setProfile(user, {}); // ensure a profile row exists first
  await db.query(
    'UPDATE user_profiles SET notifications_enabled = $1, updated_at = NOW() WHERE user_id = $2',
    [!!enabled, user.id]
  );
  return !!enabled;
}

function _resetForTests() { ensured = false; }

module.exports = {
  ensureTable, create, listForUser, unreadCount, markRead, markAllRead,
  getPref, setPref, recipientClause, _resetForTests,
};
