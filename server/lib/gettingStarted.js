'use strict';
// The getting-started guide, copied into each person's own library.
//
// Every personal library gets one copy of "Getting started with Depot" (a PDF and a Word
// file) at its root: when the library is made at the person's first sign-in, and, for
// libraries that existed before this release, by a pass at startup. The copy is theirs
// like anything they uploaded: they can rename it, move it or delete it, and a later
// release never replaces it.
//
// Once, and only once (migration 0018):
// - A library is CLAIMED (getting_started_claimed_at) before anything is written, so two
//   starts, or a first sign-in racing the startup pass, never add it twice. A claim older
//   than CLAIM_LEASE is treated as abandoned (the process died mid-way) and can be taken
//   again; a failure gives the claim back at once.
// - getting_started_at is stamped only after both files are in place. From then on the
//   library is never touched again, whatever its owner does with the files.
// - A file is skipped if the library has EVER held those exact bytes (live, in the trash,
//   renamed or moved): a retry after a half-finished attempt must not bring back a copy
//   the person already deleted or put somewhere else. A different file that happens to
//   carry the guide's name at the root is kept, and the guide is not added beside it.
//
// It is not an upload: the audit chain records 'guide_added', not 'uploaded', and the
// activity log is left alone, so the upload trend on Home and the "active people" count
// do not jump when every library gets its copy at once. Its text is not indexed either:
// a workspace of N people would otherwise have N identical guides answering every search
// and every question put to the AI. Found by name, not by contents.
//
// An admin can switch it off for the workspace (setting getting_started_guide, on unless
// set to 'false'). Off means no new copies; it removes none.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const settings = require('./settings');
const storage = require('./storage');

const ASSET_DIR = path.join(__dirname, '..', 'assets', 'getting-started');
const PDF_NAME = 'Getting started with Depot.pdf';
const FILES = [
  { name: PDF_NAME, mime: 'application/pdf' },
  { name: 'Getting started with Depot.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
];
const CLAIM_LEASE = "interval '15 minutes'";
const pdfPath = () => path.join(ASSET_DIR, PDF_NAME);

let _stopping = false;
function stop() { _stopping = true; }

async function enabled() {
  const v = await settings.getOrEnv('getting_started_guide');
  return String(v == null || v === '' ? 'true' : v).trim().toLowerCase() !== 'false';
}

// The bundled files, read and hashed once per process (they only change with a release).
let _bundle = null;
async function bundle() {
  if (_bundle) return _bundle;
  const out = [];
  for (const f of FILES) {
    const file = path.join(ASSET_DIR, f.name);
    if (!fs.existsSync(file)) continue;
    const bytes = await fs.promises.readFile(file);
    out.push({ ...f, bytes, hash: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  _bundle = out;
  return out;
}

// Put the guide in one personal library, for the person it belongs to. Returns true when
// this call finished it, false when there was nothing to do (switched off, no files in
// this build, already done or being done, not this person's live personal library, a
// viewer). Throws only when adding failed, after giving the claim back.
// Sign-in starts a seed without waiting for it. Each one is tracked until it finishes so
// settled() can wait for them: a database reset (tests) or a shutdown that runs while a
// seed is mid-transaction otherwise deadlocks against it.
const _inFlight = new Set();
function seedLibrary(libraryId, user) {
  const p = seedLibraryNow(libraryId, user);
  _inFlight.add(p);
  p.then(() => _inFlight.delete(p), () => _inFlight.delete(p));
  return p;
}
async function settled() { await Promise.allSettled([..._inFlight]); }

async function seedLibraryNow(libraryId, user) {
  if (!libraryId || !user?.id || user.role === 'viewer') return false;
  if (!(await enabled())) return false;
  const files = await bundle();
  if (!files.length) return false;
  const claimed = await db.queryOne(
    `UPDATE libraries SET getting_started_claimed_at = NOW()
      WHERE id = $1 AND owner_id = $2 AND personal AND archived_at IS NULL AND getting_started_at IS NULL
        AND (getting_started_claimed_at IS NULL OR getting_started_claimed_at < NOW() - ${CLAIM_LEASE})
      RETURNING id`, [libraryId, user.id]);
  if (!claimed) return false;
  // Lazy: documents.js requires libraries.js at load, and this module is reached from
  // the sign-in path, so a top-level require here would be a cycle waiting to happen.
  const { createDocumentRecord } = require('./documents');
  try {
    for (const f of files) {
      const had = await db.queryOne(
        `SELECT 1 FROM documents
          WHERE library_id = $1 AND (content_hash = $2 OR (name = $3 AND deleted_at IS NULL)) LIMIT 1`,
        [libraryId, f.hash, f.name]);
      if (had) continue;
      // Every library gets its own blob: a hard delete removes a document's blob by path,
      // with no count of who else points at it.
      const storagePath = `documents/${crypto.randomUUID()}-${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      await storage.upload(storagePath, f.bytes, f.mime);
      try {
        await createDocumentRecord({
          displayName: f.name, storagePath, mimetype: f.mime, storedSize: f.bytes.length,
          user, libraryId, libraryScoped: true, notifyUpload: false,
          sourceDetail: 'getting-started guide', eventType: 'guide_added', logActivity: false,
          precomputed: { contentHash: f.hash, documentText: null },
          // Asked again inside the placement, under the library's lock: the library may
          // have been put away or handed to someone else since the claim was taken.
          resolve: async (q) => {
            const still = await q.queryOne(
              'SELECT 1 FROM libraries WHERE id = $1 AND owner_id = $2 AND personal AND archived_at IS NULL', [libraryId, user.id]);
            if (!still) throw new Error('the library is no longer this person\'s own');
            return { displayName: f.name, libraryScoped: true };
          },
        });
      } catch (e) {
        if (e.notPlaced) await storage.del(storagePath).catch(() => {});
        throw e;
      }
    }
    await db.query('UPDATE libraries SET getting_started_at = NOW(), getting_started_claimed_at = NULL WHERE id = $1', [libraryId]);
    return true;
  } catch (e) {
    await db.query('UPDATE libraries SET getting_started_claimed_at = NULL WHERE id = $1', [libraryId]).catch(() => {});
    throw e;
  }
}

// The pass for libraries made before this release, and a retry for any copy that failed
// or was cut short last time. One library at a time; it stops between libraries when the
// server is shutting down. A switched-off owner, and a viewer, are skipped untouched, so
// switching them back on (or making them a contributor) later still brings their copy.
async function backfill({ log = () => {} } = {}) {
  if (!(await enabled())) return { candidates: 0, added: 0, failed: 0, disabled: true };
  if (!(await bundle()).length) return { candidates: 0, added: 0, failed: 0, missing: true };
  const rows = await db.query(
    `SELECT id, owner_id FROM libraries
      WHERE personal AND archived_at IS NULL AND getting_started_at IS NULL AND owner_id IS NOT NULL
        AND (getting_started_claimed_at IS NULL OR getting_started_claimed_at < NOW() - ${CLAIM_LEASE})
      ORDER BY created_at`);
  const { resolveActor } = require('./documentAccess');
  let added = 0, failed = 0;
  for (const row of rows) {
    if (_stopping) break;
    const user = await resolveActor(row.owner_id);
    if (!user || user.role === 'viewer') continue;
    try { if (await seedLibrary(row.id, user)) added++; }
    catch (e) { failed++; log(`getting-started guide: library ${row.id}: ${e.message}`); }
  }
  return { candidates: rows.length, added, failed };
}

module.exports = { seedLibrary, settled, backfill, enabled, stop, pdfPath, ASSET_DIR, FILES, _resetForTests: () => { _bundle = null; _stopping = false; } };
