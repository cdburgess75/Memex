'use strict';
// In-app notifications. Recipients are matched by user_id OR email (a recipient
// may be notified before they've ever logged in / have a user_id). Schema —
// including the opt-out pref on user_profiles — comes from
// migrations/0004_runtime_ensure_tables.sql.
const db = require('./db');
const profiles = require('./profiles');

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
// No-op (returns null) when the recipient has opted out, or — when
// `dedupeMinutes` is set — when a matching (type + ref_id + recipient)
// notification already exists inside that window (tames autosave/repeat spam).
async function create({ userId = null, userEmail = null, type, title, body = null, refType = null, refId = null, dedupeMinutes = 0 }) {
  const email = userEmail ? String(userEmail).toLowerCase() : null;
  if (!(await enabledForEmail(email))) return null;
  if (dedupeMinutes > 0) {
    const recent = await db.queryOne(
      `SELECT id FROM notifications
       WHERE type = $1
         AND ref_id IS NOT DISTINCT FROM $2
         AND ${recipientClause(3)}
         AND created_at > NOW() - ($5 || ' minutes')::interval
       LIMIT 1`,
      [type, refId, userId, email, String(dedupeMinutes)]
    );
    if (recent) return null;
  }
  return db.queryOne(
    `INSERT INTO notifications (user_id, user_email, type, title, body, ref_type, ref_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, user_id, user_email, type, title, body, ref_type, ref_id, read_at, created_at`,
    [userId, email, type, title, body, refType, refId]
  );
}

async function listForUser(user, limit = 50) {
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
  const row = await db.queryOne(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE ${recipientClause(1)} AND read_at IS NULL`,
    [user.id || null, user.email || '']
  );
  return row ? Number(row.n) : 0;
}

async function markRead(user, ids) {
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
  const rows = await db.query(
    `UPDATE notifications SET read_at = NOW()
     WHERE ${recipientClause(1)} AND read_at IS NULL RETURNING id`,
    [user.id || null, user.email || '']
  );
  return rows.length;
}

async function getPref(user) {
  if (!user?.id) return true;
  const row = await db.queryOne('SELECT notifications_enabled FROM user_profiles WHERE user_id = $1', [user.id]);
  return row ? row.notifications_enabled !== false : true;
}

async function setPref(user, enabled) {
  await profiles.setProfile(user, {}); // ensure a profile row exists first
  await db.query(
    'UPDATE user_profiles SET notifications_enabled = $1, updated_at = NOW() WHERE user_id = $2',
    [!!enabled, user.id]
  );
  return !!enabled;
}

module.exports = {
  create, listForUser, unreadCount, markRead, markAllRead,
  getPref, setPref, recipientClause,
};
