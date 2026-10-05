'use strict';
// The getting-started guide, copied into each person's own library.
//
// Every personal library gets one copy of "Getting started with Depot" (a PDF) at its
// root: when the library is made at the person's first sign-in, and, for libraries that
// existed before the guide did, by a pass at startup. The copy is theirs like anything
// they uploaded: they can rename it, move it or delete it.
//
// Once, and only once (migration 0018):
// - A library is CLAIMED (getting_started_claimed_at) before anything is written, so two
//   starts, or a first sign-in racing the startup pass, never add it twice. A claim older
//   than CLAIM_LEASE is treated as abandoned (the process died mid-way) and can be taken
//   again; a failure gives the claim back at once.
// - getting_started_at is stamped only after the file is in place. From then on nothing
//   is ever ADDED to the library again, whatever its owner does with the file.
// - The file is skipped if the library has EVER held those exact bytes (live, in the
//   trash, renamed or moved): a retry after a half-finished attempt must not bring back a
//   copy the person already deleted or put somewhere else. A different file that happens
//   to carry the guide's name at the root is kept, and the guide is not added beside it.
//
// Kept accurate (tidy(), at every start; it finds nothing to do on most of them):
// - Earlier releases added a Word copy beside the PDF. Those copies are removed, so each
//   account holds one guide, not two.
// - A copy that is an OLDER edition of the PDF is swapped for the current one, in place:
//   same file, same name, same folder, same links.
// - Only copies this module made, and only while nobody has changed them: the bytes in
//   storage must still be exactly an edition that was shipped, with no saved versions.
//   A copy somebody edited is their own work and is left alone. A copy somebody deleted
//   never comes back.
//
// It is not an upload: the audit chain records 'guide_added', not 'uploaded', and the
// activity log is left alone, so the upload trend on Home and the "active people" count
// do not jump when every library gets its copy at once. Its text is not indexed either:
// a workspace of N people would otherwise have N identical guides answering every search
// and every question put to the AI. Found by name, not by contents.
//
// An admin can switch it off for the workspace (setting getting_started_guide, on unless
// set to 'false'). Off means no new copies; the tidying above still runs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const settings = require('./settings');
const storage = require('./storage');

const ASSET_DIR = path.join(__dirname, '..', 'assets', 'getting-started');
const PDF_NAME = 'Getting started with Depot.pdf';
const FILES = [{ name: PDF_NAME, mime: 'application/pdf' }];
const PAST_EDITIONS = path.join(ASSET_DIR, 'past-editions.json');
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

// Every edition that was ever copied into people's libraries, by the SHA-256 of its bytes:
// the PDFs before the current one, and the Word copies that are no longer made. Written by
// docs/user-guide/build/ship.js each time a new edition ships.
let _past = null;
function pastEditions() {
  if (_past) return _past;
  let listed = {};
  try { listed = JSON.parse(fs.readFileSync(PAST_EDITIONS, 'utf8')); } catch { /* none recorded in this build */ }
  const hashes = (v) => (Array.isArray(v) ? v.filter(h => /^[0-9a-f]{64}$/.test(String(h))) : []);
  _past = { pdf: hashes(listed.pdf), word: hashes(listed.word) };
  return _past;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const SYSTEM = 'system@guide';

// A Word copy goes: the row first (and only if it is still the file that was checked),
// then its blob, as the trash sweeper does it. Whatever hangs off the row (its grants, its
// links, its follows) goes with it.
// A live copy goes under the library's lock and, like any delete, leaves a shared folder
// it was the last file in standing (empty, still shared) rather than as a bare name a
// future folder could inherit (see keepMarker.js).
async function removeCopy(d) {
  const { withFolderOp } = require('./folderOps');
  const { keepSharedFoldersAlive } = require('./keepMarker');
  const { gone, planted } = await withFolderOp({ libraryIds: [d.library_id], kind: 'placement', mode: 'shared' }, async (q) => {
    const rows = await q.query(
      `DELETE FROM documents d
        WHERE d.id = $1 AND d.storage_path = $2 AND d.content_hash = $3
          AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.document_id = d.id)
        RETURNING d.storage_path, d.name, d.deleted_at`, [d.id, d.storage_path, d.content_hash]);
    if (!rows.length) return { gone: null, planted: [] };   // edited, or already removed, in the meantime
    const live = rows.filter(r => !r.deleted_at).map(r => r.name);
    return { gone: rows[0], planted: live.length ? await keepSharedFoldersAlive(q, d.library_id, live) : [] };
  });
  if (!gone) return false;
  for (const m of planted) await storage.upload(m.storagePath, Buffer.alloc(0), 'application/octet-stream').catch(() => {});
  await storage.del(gone.storage_path).catch(() => {});
  await require('./auditLog').append({
    documentId: d.id, eventType: 'guide_removed', actorId: null, actorEmail: SYSTEM,
    detail: `Word copy of the getting-started guide · ${d.name || ''}`.trim(),
  }).catch(() => {});
  return true;
}

// An older PDF becomes the current one in place. The new bytes are stored first, under a
// path of their own, and the row is pointed at them only if it is still the file that was
// checked; the old blob goes last. A crash in between leaves a blob nobody points at,
// never a row pointing at nothing.
async function replaceCopy(d, current) {
  const storagePath = `documents/${crypto.randomUUID()}-${current.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  await storage.upload(storagePath, current.bytes, current.mime);
  let swapped = null;
  try {
    swapped = await db.queryOne(
      `UPDATE documents d SET storage_path = $2, size = $3, content_hash = $4
        WHERE d.id = $1 AND d.storage_path = $5 AND d.content_hash = $6 AND d.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.document_id = d.id)
        RETURNING d.id`, [d.id, storagePath, current.bytes.length, current.hash, d.storage_path, d.content_hash]);
  } finally {
    // Dropped only when the row is known not to point at it: an UPDATE that errored on
    // the way back may still have committed.
    if (!swapped) {
      const using = await db.queryOne('SELECT 1 FROM documents WHERE id = $1 AND storage_path = $2', [d.id, storagePath]).catch(() => ({}));
      if (!using) await storage.del(storagePath).catch(() => {});
    }
  }
  if (!swapped) return false;   // edited, binned or already swapped in the meantime
  await storage.del(d.storage_path).catch(() => {});
  await require('./auditLog').append({
    documentId: d.id, eventType: 'guide_updated', actorId: null, actorEmail: SYSTEM,
    detail: `getting-started guide brought up to the current edition · ${d.name || ''}`.trim(),
  }).catch(() => {});
  return true;
}

// Bring the copies earlier releases made into line with this one (see the top of the
// file). Safe to run at every start and to stop half-way: each copy is settled on its own,
// and a copy already dealt with no longer matches.
//
// documents.content_hash is written when a file is created and NOT when it is edited, so
// it finds the copies this module made but cannot say whether they are still untouched.
// That is settled by reading the bytes back from storage.
async function tidy({ log = () => {} } = {}) {
  const out = { wordRemoved: 0, pdfUpdated: 0, changedKept: 0, failed: 0 };
  const past = pastEditions();
  const current = (await bundle()).find(f => f.name === PDF_NAME) || null;
  const word = new Set(past.word);
  // Without a PDF in this build there is nothing to bring an older copy up to.
  const olderPdf = new Set(current ? past.pdf.filter(h => h !== current.hash) : []);
  const wanted = [...word, ...olderPdf];
  if (!wanted.length) return out;
  const rows = await db.query(
    `SELECT d.id, d.name, d.storage_path, d.content_hash, d.deleted_at, d.library_id
       FROM documents d
      WHERE d.content_hash = ANY($1::text[])
        AND (EXISTS (SELECT 1 FROM document_events e WHERE e.document_id = d.id AND e.event_type = 'guide_added')
             -- A copy the server placed whose 'guide_added' was lost (the process stopped
             -- between the row and the audit entry): in its owner's own library, by them,
             -- with nothing at all on record for it. A person's own upload of the same
             -- bytes always has its 'uploaded' entry.
             OR (NOT EXISTS (SELECT 1 FROM document_events e WHERE e.document_id = d.id)
                 AND EXISTS (SELECT 1 FROM libraries l WHERE l.id = d.library_id AND l.personal AND l.owner_id = d.uploaded_by)))
      ORDER BY d.created_at`, [wanted]);
  for (const d of rows) {
    if (_stopping) break;
    const isWord = word.has(d.content_hash);
    // An older PDF in the trash is left to the trash: its owner already let it go.
    if (!isWord && d.deleted_at) continue;
    try {
      const versions = await db.queryOne('SELECT 1 FROM document_versions WHERE document_id = $1 LIMIT 1', [d.id]);
      if (versions || sha256(await storage.download(d.storage_path)) !== d.content_hash) { out.changedKept++; continue; }
      if (isWord) { if (await removeCopy(d)) out.wordRemoved++; }
      else if (await replaceCopy(d, current)) out.pdfUpdated++;
    } catch (e) { out.failed++; log(`getting-started guide: could not tidy ${d.id}: ${e.message}`); }
  }
  return out;
}

module.exports = {
  seedLibrary, settled, backfill, tidy, enabled, stop, pdfPath, pastEditions, ASSET_DIR, FILES, PAST_EDITIONS,
  _resetForTests: () => { _bundle = null; _past = null; _stopping = false; },
  _setPastForTests: (past) => { _past = past; },
};

