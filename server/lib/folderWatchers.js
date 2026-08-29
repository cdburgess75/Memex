'use strict';
// "Notify me of new files here" subscriptions. A watcher is notified when
// anything is uploaded into the library (folder_path='') or a folder they
// follow (and its subfolders). The library OWNER is notified implicitly (see
// uploadNotify) — this table is for everyone else who opts in, so a non-owner
// who needs to know about uploads just follows the folder. Easy to operate:
// one toggle, self-service, no admin or owner involvement.
const db = require('./db');

let ensured = false;
async function ensure() {
  if (ensured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS folder_watchers (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      library_id       UUID,
      folder_path      TEXT        NOT NULL DEFAULT '',
      subscriber_email TEXT        NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Dedupe on (library, folder, subscriber). COALESCE the nullable library id to
  // a sentinel so the default library (no id) also dedupes under a unique index.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS folder_watchers_uniq
    ON folder_watchers (COALESCE(library_id, '00000000-0000-0000-0000-000000000000'), folder_path, lower(subscriber_email))`);
  await db.query('CREATE INDEX IF NOT EXISTS folder_watchers_lib_idx ON folder_watchers(library_id)');
  ensured = true;
}

const norm = (p) => String(p || '').replace(/^\/+|\/+$/g, '');

async function isWatching(libraryId, folderPath, email) {
  await ensure();
  const r = await db.queryOne(
    `SELECT 1 FROM folder_watchers
     WHERE library_id IS NOT DISTINCT FROM $1 AND folder_path = $2 AND lower(subscriber_email) = lower($3)`,
    [libraryId || null, norm(folderPath), email]
  );
  return !!r;
}

async function watch(libraryId, folderPath, email) {
  await ensure();
  await db.query(
    `INSERT INTO folder_watchers (library_id, folder_path, subscriber_email)
     VALUES ($1, $2, $3)
     ON CONFLICT (COALESCE(library_id, '00000000-0000-0000-0000-000000000000'), folder_path, lower(subscriber_email)) DO NOTHING`,
    [libraryId || null, norm(folderPath), String(email).toLowerCase()]
  );
}

async function unwatch(libraryId, folderPath, email) {
  await ensure();
  await db.query(
    `DELETE FROM folder_watchers
     WHERE library_id IS NOT DISTINCT FROM $1 AND folder_path = $2 AND lower(subscriber_email) = lower($3)`,
    [libraryId || null, norm(folderPath), email]
  );
}

// Emails to notify for an upload into (libraryId, folderPath): a watcher whose
// followed path is the whole library ('') or an ancestor of (or equal to) the
// upload's folder.
async function subscribersFor(libraryId, folderPath) {
  await ensure();
  const rows = await db.query(
    'SELECT subscriber_email, folder_path FROM folder_watchers WHERE library_id IS NOT DISTINCT FROM $1',
    [libraryId || null]
  );
  const p = norm(folderPath);
  return rows
    .filter((r) => r.folder_path === '' || r.folder_path === p || p.startsWith(r.folder_path + '/'))
    .map((r) => r.subscriber_email);
}

module.exports = { ensure, isWatching, watch, unwatch, subscribersFor };
