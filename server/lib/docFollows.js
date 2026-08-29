'use strict';
// "Follow this file": opt-in per-document subscription. A follower is notified
// (in-app + email) about the file's activity — edits and share downloads —
// alongside the owner. Off by default for everyone (you choose the files you
// care about); toggled by the inline bell on a file row.
const db = require('./db');

let ensured = false;
async function ensure() {
  if (ensured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS document_follows (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id      UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      subscriber_email TEXT        NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS document_follows_uniq ON document_follows(document_id, lower(subscriber_email))');
  await db.query('CREATE INDEX IF NOT EXISTS document_follows_doc_idx ON document_follows(document_id)');
  ensured = true;
}

async function follow(docId, email) {
  await ensure();
  await db.query(
    'INSERT INTO document_follows (document_id, subscriber_email) VALUES ($1, $2) ON CONFLICT (document_id, lower(subscriber_email)) DO NOTHING',
    [docId, String(email).toLowerCase()]
  );
}
async function unfollow(docId, email) {
  await ensure();
  await db.query('DELETE FROM document_follows WHERE document_id = $1 AND lower(subscriber_email) = lower($2)', [docId, email]);
}
async function isFollowing(docId, email) {
  await ensure();
  return !!(await db.queryOne('SELECT 1 FROM document_follows WHERE document_id = $1 AND lower(subscriber_email) = lower($2)', [docId, email]));
}
// Follower emails for a doc, minus an actor (the person who caused the activity).
async function followersOf(docId, exceptEmail) {
  await ensure();
  const rows = await db.query('SELECT subscriber_email FROM document_follows WHERE document_id = $1', [docId]);
  const except = String(exceptEmail || '').toLowerCase();
  return rows.map((r) => r.subscriber_email).filter((e) => e.toLowerCase() !== except);
}
// Which of these doc ids does this user follow (for the inline bells).
async function followedIds(email) {
  await ensure();
  const rows = await db.query('SELECT document_id FROM document_follows WHERE lower(subscriber_email) = lower($1)', [email]);
  return rows.map((r) => r.document_id);
}

module.exports = { ensure, follow, unfollow, isFollowing, followersOf, followedIds };
