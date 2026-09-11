#!/usr/bin/env node
'use strict';
// Read-only self-check for "who has access, and why" (piece 3). Run it on a box after a
// release, inside the app container:
//
//   docker compose exec -T app node scripts/access-selfcheck.js
//
// It opens the database READ ONLY (every write is refused by Postgres) and checks that
// the lists agree with the access rule on the live data:
//   drift     reasons that don't explain the rule's level, at every library door, every
//             folder door, and a sample of files (the lists still show the rule's level
//             when this happens, but it means the reasons and the rule have parted);
//   mismatch  a file's list naming a level the rule, asked account by account through
//             getAccessibleDocument, doesn't give -- or someone's own "you" disagreeing
//             with what a manager's list says about them;
//   blank     per-file grants to an empty subject (they would match every account with
//             no verified address; migration 0009 stops new ones).
// Prints ids and counts only, never names or addresses. Exit code 0 when all are 0.
const base = process.env.DATABASE_URL || '';
process.env.DATABASE_URL = base + (base.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent('-c default_transaction_read_only=on');

const db = require('../server/lib/db');
const documentAccess = require('../server/lib/documentAccess');
const libraries = require('../server/lib/libraries');
const accessKeys = require('../server/lib/accessKeys');

const SAMPLE = Number(process.env.SELFCHECK_FILES) || 500;

async function main() {
  const ro = await db.queryOne('SHOW default_transaction_read_only');
  if (!ro || ro.default_transaction_read_only !== 'on') throw new Error('refusing to run: the connection is not read-only');
  const drift = [];
  const mismatch = [];
  const origError = console.error;
  console.error = (msg, info) => { if (msg === 'access-keys drift') drift.push(info); else origError(msg, info); };

  const adminRow = await db.queryOne("SELECT user_id FROM user_roles WHERE role = 'admin' ORDER BY assigned_at LIMIT 1");
  if (!adminRow) throw new Error('no admin account to read the lists as');
  const admin = await documentAccess.resolveActor(adminRow.user_id);
  const accounts = await db.query('SELECT user_id FROM user_roles ORDER BY user_id');
  const actors = [];
  for (const a of accounts) actors.push(await documentAccess.resolveActor(a.user_id));

  // Library and folder doors: every library, its root and every folder in it.
  const libs = await db.query('SELECT id FROM libraries ORDER BY created_at');
  let doors = 0;
  for (const lib of libs) {
    const listed = await libraries.visibleLibraryRow(admin, lib.id);
    const library = libraries.shapeLibrary(admin, listed);
    const folders = await db.query(
      `SELECT DISTINCT p FROM (
         SELECT array_to_string((string_to_array(d.name, '/'))[1:n], '/') AS p
           FROM documents d, generate_series(1, greatest(array_length(string_to_array(d.name, '/'), 1) - 1, 0)) AS n
          WHERE d.library_id = $1 AND d.deleted_at IS NULL
         UNION SELECT folder_path FROM library_grants WHERE library_id = $1 AND folder_path <> '') x ORDER BY p`,
      [lib.id]);
    for (const path of ['', ...folders.map(f => f.p)]) {
      const resp = await accessKeys.libraryDoor(admin, { library, listed, path, manager: true });
      doors++;
      const levels = new Map(resp.people.filter(p => p.level).map(p => [String(p.user_id), p.level]));
      // each account's own view of the same door, as its own request would see it
      for (const who of actors) {
        const theirRow = await libraries.visibleLibraryRow(who, lib.id);
        if (!theirRow) continue;
        const theirs = await accessKeys.libraryDoor(who, { library: libraries.shapeLibrary(who, theirRow), listed: theirRow, path, manager: false });
        if ((theirs.you.level || null) !== (levels.get(String(who.id)) || null)) mismatch.push({ library: lib.id, path: path ? '(folder)' : '', user_id: who.id, you: theirs.you.level, list: levels.get(String(who.id)) || null });
      }
    }
  }

  // A sample of files: the list's levels against the rule, account by account.
  const files = await db.query(
    `SELECT d.id, d.name, d.library_id, d.library_scoped, d.uploaded_by, d.uploaded_by_email FROM documents d
      WHERE d.deleted_at IS NULL ORDER BY random() LIMIT $1`, [SAMPLE]);
  for (const doc of files) {
    const library = doc.library_id ? await db.queryOne('SELECT id, name, owner_id, owner_email FROM libraries WHERE id = $1', [doc.library_id]) : null;
    const resp = await accessKeys.fileDoor(admin, { doc, library, full: true, detail: 'full' });
    const levels = new Map(resp.people.filter(p => p.level).map(p => [String(p.user_id), p.level]));
    for (const who of actors) {
      let level = null;
      for (const l of ['read', 'write', 'admin']) {
        if (await documentAccess.getAccessibleDocument({ id: doc.id, user: who, required: l, columns: 'd.id' })) level = l;
      }
      if (level !== (levels.get(String(who.id)) || null)) mismatch.push({ document: doc.id, user_id: who.id, rule: level, list: levels.get(String(who.id)) || null });
    }
  }

  const blank = (await db.queryOne("SELECT count(*)::int AS n FROM document_acl WHERE subject_id = ''")).n;
  console.error = origError;
  const ok = !drift.length && !mismatch.length && !blank;
  console.log(`ACCESS SELF-CHECK ${ok ? 'OK' : 'FAILED'} accounts=${actors.length} libraries=${libs.length} doors=${doors} files=${files.length} drift=${drift.length} mismatch=${mismatch.length} blank_subjects=${blank}`);
  for (const d of drift.slice(0, 20)) console.log('  drift', JSON.stringify(d));
  for (const m of mismatch.slice(0, 20)) console.log('  mismatch', JSON.stringify(m));
  return ok;
}

main()
  .then(async (ok) => { await db.end(); process.exit(ok ? 0 : 1); })
  .catch(async (e) => { console.log(`ACCESS SELF-CHECK ERROR ${e.message}`); try { await db.end(); } catch { /* closed */ } process.exit(2); });
