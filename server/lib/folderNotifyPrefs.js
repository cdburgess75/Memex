'use strict';
// Per-user new-file-notification preferences, as OVERRIDES of the role default:
// the library owner is ON by default, members are OFF by default. A row here is
// an explicit choice (enabled true/false) for a person at a library
// (folder_path='') or a folder (and its subfolders). No row → the role default.
// One toggle in the folder 3-dots menu, self-service, either direction.
// Schema (including the folder_notify_prefs_uniq expression index the
// ON CONFLICT below infers against): migrations/0004_runtime_ensure_tables.sql.
const db = require('./db');

const norm = (p) => String(p || '').replace(/^\/+|\/+$/g, '');
// A pref at the library root ('') or an ancestor folder applies to an upload at p.
const applies = (rowPath, p) => rowPath === '' || rowPath === p || p.startsWith(rowPath + '/');

// Set (or update) this user's explicit choice for this place.
async function setPref(libraryId, folderPath, email, enabled) {
  await db.query(
    `INSERT INTO folder_notify_prefs (library_id, folder_path, subscriber_email, enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (COALESCE(library_id, '00000000-0000-0000-0000-000000000000'), folder_path, lower(subscriber_email))
       DO UPDATE SET enabled = EXCLUDED.enabled`,
    [libraryId || null, norm(folderPath), String(email).toLowerCase(), !!enabled]
  );
}

// This user's effective explicit pref for an upload at folderPath (most specific
// matching row wins), or null when they have no applicable choice.
async function prefForUser(libraryId, folderPath, email) {
  const rows = await db.query(
    'SELECT folder_path, enabled FROM folder_notify_prefs WHERE library_id IS NOT DISTINCT FROM $1 AND lower(subscriber_email) = lower($2)',
    [libraryId || null, email]
  );
  const p = norm(folderPath);
  const m = rows.filter((r) => applies(r.folder_path, p)).sort((a, b) => b.folder_path.length - a.folder_path.length);
  return m.length ? m[0].enabled : null;
}

// Map lower(email) → enabled, one entry per person who has an applicable pref
// (most specific wins). Used to override the role defaults during fan-out.
async function effectiveFor(libraryId, folderPath) {
  const rows = await db.query(
    'SELECT subscriber_email, folder_path, enabled FROM folder_notify_prefs WHERE library_id IS NOT DISTINCT FROM $1',
    [libraryId || null]
  );
  const p = norm(folderPath);
  const best = new Map();
  for (const r of rows) {
    if (!applies(r.folder_path, p)) continue;
    const k = r.subscriber_email.toLowerCase();
    const cur = best.get(k);
    if (!cur || r.folder_path.length > cur.folder_path.length) best.set(k, r);
  }
  const out = new Map();
  for (const [k, r] of best) out.set(k, r.enabled);
  return out;
}

// All of this user's explicit prefs in a library (for the inline bells).
async function listUserPrefs(libraryId, email) {
  return db.query(
    'SELECT folder_path, enabled FROM folder_notify_prefs WHERE library_id IS NOT DISTINCT FROM $1 AND lower(subscriber_email) = lower($2)',
    [libraryId || null, email]
  );
}

module.exports = { setPref, prefForUser, effectiveFor, listUserPrefs };
