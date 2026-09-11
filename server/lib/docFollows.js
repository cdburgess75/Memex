'use strict';
// "Follow this file": opt-in per-document subscription. A follower is notified
// (in-app + email) about the file's activity — edits and share downloads —
// alongside the owner. Off by default for everyone (you choose the files you
// care about); toggled by the inline bell on a file row.
// Schema: migrations/0004_runtime_ensure_tables.sql.
const db = require('./db');
const documentAccess = require('./documentAccess');

async function follow(docId, email) {
  await db.query(
    'INSERT INTO document_follows (document_id, subscriber_email) VALUES ($1, $2) ON CONFLICT (document_id, lower(subscriber_email)) DO NOTHING',
    [docId, String(email).toLowerCase()]
  );
}
async function unfollow(docId, email) {
  await db.query('DELETE FROM document_follows WHERE document_id = $1 AND lower(subscriber_email) = lower($2)', [docId, email]);
}
async function isFollowing(docId, email) {
  return !!(await db.queryOne('SELECT 1 FROM document_follows WHERE document_id = $1 AND lower(subscriber_email) = lower($2)', [docId, email]));
}
// Follower emails for a doc, minus an actor (the person who caused the activity) --
// and minus anyone who can no longer read it. Following is only checked when someone
// starts following; access can end afterwards (a share removed, a group left), and a
// former follower must not keep receiving the file's name and who touched it.
async function followersOf(docId, exceptEmail) {
  const rows = await db.query('SELECT subscriber_email FROM document_follows WHERE document_id = $1', [docId]);
  const except = String(exceptEmail || '').toLowerCase();
  const candidates = rows.map((r) => r.subscriber_email).filter((e) => e && e.toLowerCase() !== except);
  if (!candidates.length) return [];
  const readers = await documentAccess.readersAmong([docId], candidates);
  return candidates.filter((e) => readers.get(e.toLowerCase())?.has(String(docId)));
}
// Which of these doc ids does this user follow (for the inline bells).
async function followedIds(email) {
  const rows = await db.query('SELECT document_id FROM document_follows WHERE lower(subscriber_email) = lower($1)', [email]);
  return rows.map((r) => r.document_id);
}

module.exports = { follow, unfollow, isFollowing, followersOf, followedIds };
