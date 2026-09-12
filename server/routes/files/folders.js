'use strict';
// Folder-operations sub-router, mounted at /api/files/folder by routes/files.js.
// Covers create/rename/delete/reparent/move, folder ZIP download, public folder
// download links, and folder-wide member (ACL) management. Split out of the
// monolithic files router (ST-1); shared helpers live in lib/ (fileEvents,
// shareLinks, documents) so this router doesn't depend on the parent module.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');

const auth = require('../../middleware/auth');
const requireRole = require('../../middleware/requireRole');
const { serverError } = require('../../lib/httpError');
const db = require('../../lib/db');
const documentAccess = require('../../lib/documentAccess');
const libraries = require('../../lib/libraries');
const storage = require('../../lib/storage');
const notifications = require('../../lib/notifications');
const emailEvents = require('../../lib/emailEvents');
const { zipStream } = require('../../lib/zip');
const { logEvent, logDocumentEvent, requestAuditDetail } = require('../../lib/fileEvents');
const { folderShareClientShape, tokenHash, passwordParts, verifySharePassword, publicAppBase } = require('../../lib/shareLinks');
const { safeDocName, folderLookupPath, destinationFolder, createDocumentRecord, DOCUMENT_COLUMNS } = require('../../lib/documents');
const { isUuid } = require('../../lib/groups');
const { withFolderOp, sendFolderOpError, FolderOpError, whatIsAt } = require('../../lib/folderOps');

// Total-size ceiling for a folder ZIP (the archive is buffered in memory, so this
// bounds peak RAM — matched between the authed /folder/zip route and the public link).
const FOLDER_ZIP_MAX_BYTES = 500 * 1024 * 1024;
// Upper bound on how many files a single folder copy will duplicate in one request,
// so a pathological folder can't tie up the event loop (or disk) unbounded.
const FOLDER_COPY_MAX_FILES = 5000;

/* Which library does this folder path live in?
 *
 * A folder is not a row — it is a name prefix on documents — and a name is only
 * unique within a library, so "Clients/Acme" can exist in several at once. Every
 * folder query below is therefore scoped to one library id; without that, a single
 * rename, delete or member-grant reaches across every library the caller can read.
 *
 * The caller may name the library explicitly (x-library-id header, or
 * source_library_id). Otherwise it is inferred from the folder itself, so existing
 * clients keep working: one candidate is used, several is an ambiguity the caller
 * must settle, none lets the handler 404 as it did before. This deliberately does
 * NOT read body.library_id — on /move and /copy that is the *target* library.
 *
 * An explicit id that is not a uuid is a 400: passed on, Postgres would refuse it with
 * a cast error that surfaces as a 500. An explicit id is also checked against the
 * folder: one that doesn't hold it (for this caller) is the same 404 as a folder that
 * can't be found, not a 200 that quietly touched nothing.
 */
async function folderLibraryId(req, folderPath, user) {
  const explicit = req.headers['x-library-id'] || req.body?.source_library_id || req.query?.source_library_id;
  if (explicit) {
    if (!isUuid(explicit)) { const e = new Error('Bad library id'); e.status = 400; throw e; }
    const held = await db.queryOne(
      `SELECT 1 FROM documents d
       WHERE d.deleted_at IS NULL AND d.library_id = $1 AND starts_with(d.name, $2 || '/') AND ${documentAccess.condition('d', 3)}
       LIMIT 1`,
      [String(explicit), folderPath, ...documentAccess.userParams(user, 'read')]
    );
    return held ? String(explicit) : null;
  }
  const rows = await db.query(
    `SELECT DISTINCT d.library_id FROM documents d
     WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND ${documentAccess.condition('d', 2)}`,
    [folderPath, ...documentAccess.userParams(user, 'read')]
  );
  if (rows.length > 1) {
    const e = new Error('That folder name exists in more than one library. Re-send with source_library_id.');
    e.status = 409;
    throw e;
  }
  return rows.length ? rows[0].library_id : null;
}

// Surface an ambiguous folder (409) or a malformed library id (400) as themselves
// rather than a generic 500.
function folderScopeError(res, e) {
  if (e && (e.status === 409 || e.status === 400)) { res.status(e.status).json({ error: e.message }); return true; }
  return false;
}

// Folder paths that name an EXISTING folder are matched exactly (folderLookupPath);
// only the path of a folder being created goes through safeDocName, and a destination
// that may be partly new goes through destinationFolder. Matching uses starts_with
// rather than LIKE, so '_' and '%' in a folder name are ordinary characters: "Q1_A"
// no longer also reaches "Q1-A", nor "50%" reach "500".
function existingFolder(raw) { return folderLookupPath(raw); }

// The right to add files at a place in a library (libraries.writeRight). Sends the
// refusal and returns null when there is none.
async function destinationRight(res, user, libraryId, path) {
  const r = await libraries.writeRight(user, libraryId, path);
  if (r.status) { res.status(r.status).json({ error: r.error }); return null; }
  return r;
}

// Folder shares are keyed by path, so until renames and moves carry them along, a folder
// with a share at or below it must not be renamed, moved or deleted: the share would be
// orphaned, or re-attach to whatever next took the name. These two run INSIDE a folder
// operation's transaction, on its client, and refuse by throwing so it rolls back.
const folderSharedError = () => new FolderOpError('FOLDER_SHARED', 409,
  "This folder is shared. Remove its shares before renaming, moving or deleting it.");
async function sharedAt(q, libraryId, ...paths) {
  for (const p of paths) {
    if (p && await libraries.sharedFolderAt(libraryId, p, q)) return true;
  }
  return false;
}
// Nothing may be moved or renamed ONTO an existing folder. Merging two folders would
// mix their sharing: each side's people would gain the other's files, and no merge rule
// can keep both boundaries, since the wider one always wins. A folder in the Trash keeps
// its name for the whole retention window, so it blocks too -- and has to say so, or the
// refusal would point at a folder nobody can see.
async function refuseIfSomethingIsAt(q, { destLibraryId, newPath, fromLibraryId, fromPath, viewer, verb }) {
  const at = await whatIsAt(q, { destLibraryId, newPath, fromLibraryId, fromPath, viewer });
  const name = String(newPath).split('/').pop();
  if (at?.has_live || at?.has_shares) {
    throw new FolderOpError('FOLDER_EXISTS', 409,
      `There is already a folder called “${name}” there, so this ${verb} would merge the two. Rename one of them first, or move the files instead.`,
      { path: newPath });
  }
  if (at?.trashed_at) {
    const when = new Date(at.trashed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    throw new FolderOpError('FOLDER_EXISTS_IN_TRASH', 409,
      `A folder called “${name}” was deleted there on ${when} and is still in the Trash under that name. Choose another name, or ask an admin to empty it first.`,
      { path: newPath, trashed_at: at.trashed_at });
  }
}

async function writeRightOrThrow(user, libraryId, path, q) {
  const r = await libraries.writeRight(user, libraryId, path, q);
  if (r.status) throw new FolderOpError(null, r.status, r.error);
  return r;
}

// SQL for "is library content after the move" (see routes/files.js libraryScopeAfterMove),
// with its two parameters starting at $n: the destination is scoped, and the mover's id.
// Only the mover's own files change -- admins included. IS NOT DISTINCT FROM keeps a row
// with no recorded uploader false rather than NULL (the column is NOT NULL).
const scopeAfterMove = (n) => `d.library_scoped OR ($${n}::boolean AND d.uploaded_by IS NOT DISTINCT FROM $${n + 1})`;

// POST /api/files/folder — create an (empty) folder via a hidden .keep marker
router.post('/', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const libraryId = req.body?.library_id || (await libraries.defaultLibraryId());
    // A new folder inside an existing (or shared) one keeps that folder's name exactly;
    // only the new part is named the way new folders are.
    const folderPath = await destinationFolder(req.body?.path, libraryId, req.user);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const dest = await destinationRight(res, req.user, libraryId, folderPath);
    if (!dest) return;
    const markerName = `${folderPath}/.keep`;
    const storagePath = `documents/${Date.now()}-keep`;
    await storage.upload(storagePath, Buffer.alloc(0), 'application/octet-stream');
    const doc = await db.queryOne(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
       VALUES ($1, 0, $2, $3, $4, $5, $6, $7) RETURNING ${DOCUMENT_COLUMNS}`,
      [markerName, 'application/octet-stream', storagePath, req.user.id, req.user.email, libraryId, dest.scoped]
    );
    await documentAccess.grantOwnerAdmin(doc.id, req.user);
    res.json({ ok: true, path: folderPath });
  } catch (e) { if (folderScopeError(res, e)) return; serverError(res, e); }
});

// POST /api/files/folder/rename — rename a folder (re-prefix every file under it)
router.post('/rename', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const oldPath = existingFolder(req.body?.path);
    const rawName = String(req.body?.name || '').trim();
    if (!oldPath || !rawName) return res.status(400).json({ error: 'path and name required' });
    if (/[\/\\]/.test(rawName) || rawName === '..' || rawName === '.') return res.status(400).json({ error: 'invalid name' });
    // Strip HTML-significant and control characters (single folder segment).
    const newName = rawName.replace(/[^a-zA-Z0-9._ -]/g, '_');
    const parent = oldPath.split('/').slice(0, -1).join('/');
    const newPath = parent ? `${parent}/${newName}` : newName;
    const libraryId = await folderLibraryId(req, oldPath, req.user);
    if (!libraryId) return res.status(404).json({ error: 'Folder not found' });
    if (newPath === oldPath) return res.json({ ok: true, path: oldPath, count: 0 }); // renamed to what it is called
    // Everything from here happens inside one transaction holding the library's tree
    // lock, and every check is re-run on that client: nothing may place a document by
    // name, or rename anything else in this library, while this runs.
    const rows = await withFolderOp({ libraryIds: [libraryId] }, async (q) => {
      if (await sharedAt(q, libraryId, oldPath)) throw folderSharedError();
      const dest = await writeRightOrThrow(req.user, libraryId, newPath, q);
      await refuseIfSomethingIsAt(q, { destLibraryId: libraryId, newPath, fromLibraryId: libraryId, fromPath: oldPath, viewer: req.user, verb: 'rename' });
      if (await sharedAt(q, libraryId, newPath)) throw folderSharedError();
      void dest; // a rename keeps the folder where it is: what is library content doesn't change
      return q.query(
        `UPDATE documents d SET name = $2 || substring(d.name from $3::int)
         WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND d.library_id = $9 AND ${documentAccess.condition('d', 4)}
         RETURNING d.id`,
        // substring() counts characters, and JavaScript's .length counts UTF-16 units, so
        // a folder name with an emoji in it would otherwise be cut one character short.
        [oldPath, newPath, Array.from(oldPath).length + 1, ...documentAccess.userParams(req.user, 'write'), libraryId]
      );
    });
    await logEvent(`folder rename · ${oldPath} → ${newPath}`, req.user.id, req.user.email);
    await logDocumentEvent(null, 'folder_renamed', req.user.id, req.user.email, `${oldPath} → ${newPath} (${rows.length})`);
    res.json({ ok: true, path: newPath, count: rows.length });
  } catch (e) { if (sendFolderOpError(res, e) || folderScopeError(res, e)) return; serverError(res, e); }
});

// POST /api/files/folder/delete — move a whole folder's contents to Trash
router.post('/delete', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = existingFolder(req.body?.path);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const libraryId = await folderLibraryId(req, folderPath, req.user);
    if (!libraryId) return res.status(404).json({ error: 'Folder not found' });
    const rows = await withFolderOp({ libraryIds: [libraryId] }, async (q) => {
      if (await sharedAt(q, libraryId, folderPath)) throw folderSharedError();
      return q.query(
        `UPDATE documents d SET deleted_at = NOW(), deleted_by = $2, deleted_by_email = $3
         WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND d.library_id = $9 AND ${documentAccess.condition('d', 4)}
         RETURNING d.id`,
        [folderPath, req.user.id, req.user.email, ...documentAccess.userParams(req.user, 'write'), libraryId]
      );
    });
    await logEvent(`folder trash · ${folderPath} (${rows.length})`, req.user.id, req.user.email);
    await logDocumentEvent(null, 'folder_trashed', req.user.id, req.user.email, `${folderPath} (${rows.length})`);
    res.json({ ok: true, count: rows.length });
  } catch (e) { if (sendFolderOpError(res, e) || folderScopeError(res, e)) return; serverError(res, e); }
});

// POST /api/files/folder/reparent — move a folder under a different parent (drag-drop)
router.post('/reparent', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const oldPath = existingFolder(req.body?.path);
    if (!oldPath) return res.status(400).json({ error: 'path required' });
    const srcLibraryId = await folderLibraryId(req, oldPath, req.user);
    if (!srcLibraryId) return res.status(404).json({ error: 'Folder not found' });
    // The target may be an existing folder (kept exactly), a new one (the folder
    // picker's "+ New folder..."), or an existing folder with new ones under it; the
    // new part is named the way the files moved alongside it are ('' = the root).
    const target = await destinationFolder(req.body?.target, srcLibraryId, req.user);
    if (target === null) return res.status(400).json({ error: 'invalid target' });
    const base = oldPath.split('/').pop();
    const newPath = target ? `${target}/${base}` : base;
    if (newPath === oldPath) return res.json({ ok: true, path: oldPath, count: 0 }); // already there
    if (target === oldPath || target.startsWith(oldPath + '/')) return res.status(400).json({ error: "Can't move a folder into itself" });
    const rows = await withFolderOp({ libraryIds: [srcLibraryId] }, async (q) => {
      if (await sharedAt(q, srcLibraryId, oldPath)) throw folderSharedError();
      // Moving a folder INTO another one needs the right to add files there -- dragging a
      // folder into a shared folder must not quietly share it with everyone who has access.
      // Checked before whether a share sits at the new path, so the answer can't be used
      // to probe for shares in places the caller can't write to.
      const dest = await writeRightOrThrow(req.user, srcLibraryId, newPath, q);
      await refuseIfSomethingIsAt(q, { destLibraryId: srcLibraryId, newPath, fromLibraryId: srcLibraryId, fromPath: oldPath, viewer: req.user, verb: 'move' });
      if (await sharedAt(q, srcLibraryId, newPath)) throw folderSharedError();
      return q.query(
        `UPDATE documents d SET name = $2 || substring(d.name from $3::int), library_scoped = ${scopeAfterMove(10)}
         WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND d.library_id = $9 AND ${documentAccess.condition('d', 4)}
         RETURNING d.id`,
        [oldPath, newPath, Array.from(oldPath).length + 1, ...documentAccess.userParams(req.user, 'write'), srcLibraryId,
         dest.scoped, req.user.id]
      );
    });
    await logEvent(`folder move · ${oldPath} → ${newPath}`, req.user.id, req.user.email);
    await logDocumentEvent(null, 'folder_moved', req.user.id, req.user.email, `${oldPath} → ${newPath} (${rows.length})`);
    res.json({ ok: true, path: newPath, count: rows.length });
  } catch (e) { if (sendFolderOpError(res, e) || folderScopeError(res, e)) return; serverError(res, e); }
});

// POST /api/files/folder/move — move a folder's contents to another library
router.post('/move', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = existingFolder(req.body?.path);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const libraryId = req.body?.library_id || (await libraries.defaultLibraryId());
    // The destination must be a library the caller can add files to, at this path
    // (writeRight: 400 for a malformed id, 404 for an unknown one, 403 without a right).
    // documents.library_id has no foreign key, so without this a document could be
    // stamped with a library nobody can reach and drop out of every listing.
    const dest0 = await destinationRight(res, req.user, libraryId, folderPath);
    if (!dest0) return;
    const srcLibraryId = await folderLibraryId(req, folderPath, req.user);
    if (!srcLibraryId) return res.status(404).json({ error: 'Folder not found' });
    // Both libraries are locked, in key order, so a move each way cannot deadlock.
    const { rows, kept } = await withFolderOp({ libraryIds: [srcLibraryId, libraryId] }, async (q) => {
      if (await sharedAt(q, srcLibraryId, folderPath)) throw folderSharedError();
      if (await sharedAt(q, libraryId, folderPath)) throw folderSharedError();
      const dest = await writeRightOrThrow(req.user, libraryId, folderPath, q);
      if (String(srcLibraryId) !== String(libraryId)) {
        await refuseIfSomethingIsAt(q, { destLibraryId: libraryId, newPath: folderPath, fromLibraryId: srcLibraryId, fromPath: folderPath, viewer: req.user, verb: 'move' });
      }
      // Library content belongs to its library: taking it to ANOTHER library hands it to
      // that library's owner and ends its shares, so only whoever manages the source (its
      // owner while a contributor, or an admin) may, and never into a library held only
      // under the old open rule ($11). Anyone else's move leaves it where it is, counted
      // (kept) so the app can say why -- they can still copy it.
      const managesSource = await libraries.managesLibrary(req.user, srcLibraryId, q);
      const contentMoves = String(srcLibraryId) === String(libraryId) || (managesSource && dest.right !== 'legacy');
      const moved = await q.query(
        `UPDATE documents d SET library_id = $2, library_scoped = ${scopeAfterMove(9)}
         WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND d.library_id = $8 AND ${documentAccess.condition('d', 3)}
           AND (NOT d.library_scoped OR $11::boolean)
         RETURNING d.id`,
        [folderPath, libraryId, ...documentAccess.userParams(req.user, 'write'), srcLibraryId,
         dest.scoped, req.user.id, contentMoves]
      );
      let left = 0;
      if (!contentMoves) {
        const row = await q.queryOne(
          `SELECT count(*)::int AS n FROM documents d
           WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND d.library_id = $7 AND d.library_scoped
             AND ${documentAccess.condition('d', 2)}`,
          [folderPath, ...documentAccess.userParams(req.user, 'write'), srcLibraryId]
        );
        left = row?.n || 0;
      }
      return { rows: moved, kept: left };
    });
    await logEvent(`folder move to library · ${folderPath} → ${libraryId} (${rows.length})`, req.user.id, req.user.email);
    await logDocumentEvent(null, 'folder_moved_library', req.user.id, req.user.email, `${folderPath} → library ${libraryId} (${rows.length}${kept ? `, ${kept} kept` : ''})`);
    res.json({ ok: true, count: rows.length, kept });
  } catch (e) { if (sendFolderOpError(res, e) || folderScopeError(res, e)) return; serverError(res, e); }
});

// GET /api/files/folder/zip?path=... — download a folder's files as a compressed zip
router.get('/zip', auth, async (req, res) => {
  try {
    const folderPath = existingFolder(req.query.path);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const libraryId = await folderLibraryId(req, folderPath, req.user);
    if (!libraryId) return res.status(404).json({ error: 'Folder not found' });
    const docs = await db.query(
      `SELECT d.id, d.name, d.storage_path, d.size FROM documents d
       WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND d.name NOT LIKE '%/.keep' AND d.library_id = $7 AND ${documentAccess.condition('d', 2)}
       ORDER BY d.name`,
      [folderPath, ...documentAccess.userParams(req.user, 'read'), libraryId]
    );
    if (!docs.length) return res.status(404).json({ error: 'No files in this folder' });
    const total = docs.reduce((s, d) => s + Number(d.size || 0), 0);
    if (total > FOLDER_ZIP_MAX_BYTES) return res.status(413).json({ error: 'Folder is too large to zip (over 500 MB)' });
    const base = folderPath.split('/').pop().replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.zip"`);
    // Stream the archive (one file buffered at a time) rather than building the
    // whole ZIP in memory — bounds peak RAM regardless of folder size.
    await require('stream/promises').pipeline(zipStream(folderZipEntries(docs, folderPath)), res);
  } catch (e) {
    if (!res.headersSent) { if (folderScopeError(res, e)) return; serverError(res, e); }
    else res.destroy(e);
  }
});

// Lazy ZIP entries for a folder's documents, each named relative to the folder's
// own parent so the archive unpacks into a single top-level folder. load() fetches
// one file's bytes on demand, so zipStream only ever holds one file in memory.
function folderZipEntries(docs, folderPath) {
  const parent = folderPath.split('/').slice(0, -1).join('/');
  return docs.map(d => ({
    name: parent ? d.name.slice(parent.length + 1) : d.name,
    load: () => storage.download(d.storage_path),
  }));
}

// GET /api/files/folder/links?path=... — list the caller's folder download links.
router.get('/links', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = existingFolder(req.query.path);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const adminAll = (req.user.role === 'admin');
    // Links made before folder paths were matched exactly were stored under the
    // rewritten name ("Tax _ Co" for "Tax & Co"); list those too, or a live link would
    // drop out of the only place it can be seen and revoked.
    const keys = [...new Set([folderPath, safeDocName(folderPath, '')].filter(Boolean))];
    const rows = await db.query(
      `SELECT id, folder_path, document_ids, expires_at, revoked_at, created_at,
              created_by_email, last_accessed_at, access_count, password_hash
       FROM folder_share_links
       WHERE folder_path = ANY($1::text[]) ${adminAll ? '' : 'AND created_by = $2'}
       ORDER BY revoked_at IS NULL DESC, created_at DESC
       LIMIT 100`,
      adminAll ? [keys] : [keys, req.user.id]
    );
    res.json({ shares: rows.map(r => folderShareClientShape(r)) });
  } catch (e) { if (folderScopeError(res, e)) return; serverError(res, e); }
});

// POST /api/files/folder/links — mint a public download link for a folder.
router.post('/links', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = existingFolder(req.body?.path);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    // Snapshot exactly the files the CREATOR may re-publish under this folder.
    // Requires 'write' (not 'read') to mint a public link — same bar the per-file
    // share (POST /:id/shares) enforces, so a read-only grantee can't re-expose files.
    const libraryId = await folderLibraryId(req, folderPath, req.user);
    if (!libraryId) return res.status(404).json({ error: 'Folder not found' });
    const docs = await db.query(
      `SELECT d.id, d.size FROM documents d
       WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND d.name NOT LIKE '%/.keep' AND d.library_id = $7 AND ${documentAccess.condition('d', 2)}`,
      [folderPath, ...documentAccess.userParams(req.user, 'write'), libraryId]
    );
    if (!docs.length) return res.status(404).json({ error: 'No files in this folder to share' });
    const total = docs.reduce((s, d) => s + Number(d.size || 0), 0);
    if (total > FOLDER_ZIP_MAX_BYTES) return res.status(413).json({ error: 'Folder is too large to share as a link (over 500 MB)' });

    const expiresInDays = Number.parseInt(req.body?.expiresInDays || '7', 10);
    const safeDays = Number.isFinite(expiresInDays) && expiresInDays > 0 ? Math.min(expiresInDays, 365) : 7;
    const expiresAt = req.body?.neverExpires ? null : new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000).toISOString();
    const token = crypto.randomBytes(32).toString('base64url');
    const { salt, hash } = passwordParts(String(req.body?.password || '').trim());

    const share = await db.queryOne(
      `INSERT INTO folder_share_links
       (folder_path, document_ids, token_hash, password_salt, password_hash, expires_at, created_by, created_by_email)
       VALUES ($1, $2::uuid[], $3, $4, $5, $6, $7, $8)
       RETURNING id, folder_path, document_ids, expires_at, revoked_at, created_at,
                 created_by_email, last_accessed_at, access_count, password_hash`,
      [folderPath, docs.map(d => d.id), tokenHash(token), salt, hash, expiresAt, req.user.id, req.user.email]
    );
    const url = `${await publicAppBase(req)}/api/files/folder/share/${token}`;
    await logEvent(`folder share create · ${folderPath} (${docs.length})`, req.user.id, req.user.email);
    await logDocumentEvent(null, 'folder_share_created', req.user.id, req.user.email, `${folderPath} (${docs.length})`);
    res.json({ share: folderShareClientShape(share, url) });
  } catch (e) { if (folderScopeError(res, e)) return; serverError(res, e); }
});

// DELETE /api/files/folder/links/:shareId — revoke a folder download link. Its creator
// or an admin can; so can anyone with edit rights on every file it still serves from
// (at least one) -- the same bar as revoking a file's link. Folder links carry no
// library, so the snapshot of files is the only scope there is.
router.delete('/links/:shareId', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    if (!isUuid(req.params.shareId)) return res.status(404).json({ error: 'Folder share link not found' });
    const adminAll = (req.user.role === 'admin');
    const params = [req.user.id, req.user.email, req.params.shareId, ...documentAccess.userParams(req.user, 'write')];
    const share = await db.queryOne(
      `UPDATE folder_share_links f
       SET revoked_at = NOW(), revoked_by = $1, revoked_by_email = $2
       WHERE f.id = $3 AND f.revoked_at IS NULL
         AND (${adminAll ? 'true' : `f.created_by = $1
              OR (EXISTS (SELECT 1 FROM documents d WHERE d.id = ANY(f.document_ids) AND d.deleted_at IS NULL)
                  AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = ANY(f.document_ids) AND d.deleted_at IS NULL
                                     AND NOT ${documentAccess.condition('d', 4)}))`})
       RETURNING f.id, f.folder_path`,
      adminAll ? params.slice(0, 3) : params
    );
    if (!share) return res.status(404).json({ error: 'Folder share link not found' });
    await logEvent(`folder share revoke · ${share.folder_path}`, req.user.id, req.user.email);
    await logDocumentEvent(null, 'folder_share_revoked', req.user.id, req.user.email, share.folder_path);
    res.json({ success: true });
  } catch (e) { if (folderScopeError(res, e)) return; serverError(res, e); }
});

// GET /api/files/folder/share/:token — public, revocable, expiring folder ZIP download.
router.get('/share/:token', async (req, res) => {
  const hash = tokenHash(req.params.token);
  try {
    const share = await db.queryOne('SELECT * FROM folder_share_links WHERE token_hash = $1', [hash]);
    if (!share || share.revoked_at) return res.status(404).json({ error: 'Share link not found' });
    if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'Share link expired' });
    }
    const password = req.query.password || req.headers['x-share-password'];
    if (!verifySharePassword(password, share.password_salt, share.password_hash)) {
      return res.status(401).json({ error: 'Share password required' });
    }
    // Serve only the frozen snapshot set, skipping any file deleted since creation --
    // and only the files the link's creator could still publish right now: an admin or
    // contributor with edit rights, checked live. A creator who has since lost access
    // (a share removed, a group left, a demotion) takes the link down with them, and a
    // file they lost access to drops out of it. Refused exactly like a revoked link.
    // (lib/linkAccess: the one answer the link lists show too)
    const { creator, docs } = await require('../../lib/linkAccess')
      .servableDocs(share.created_by, share.document_ids, 'd.id, d.name, d.storage_path, d.size');
    if (!creator) return res.status(404).json({ error: 'Share link not found' });
    if (!docs.length) return res.status(404).json({ error: 'These files are no longer available' });
    const total = docs.reduce((s, d) => s + Number(d.size || 0), 0);
    if (total > FOLDER_ZIP_MAX_BYTES) return res.status(413).json({ error: 'Folder is too large to download' });

    await db.query('UPDATE folder_share_links SET last_accessed_at = NOW(), access_count = access_count + 1 WHERE id = $1', [share.id]);
    await logEvent(`folder share download · ${share.folder_path}`, null, null);
    await logDocumentEvent(null, 'folder_share_downloaded', null, null, `${share.folder_path} · ${requestAuditDetail(req)}`);
    if (share.created_by_email) {
      try {
        await notifications.create({
          userId: share.created_by || null,
          userEmail: share.created_by_email,
          type: 'share_downloaded',
          title: 'Your shared folder was downloaded',
          body: `"${share.folder_path.split('/').pop()}" · via folder link`,
          dedupeMinutes: 2,
        });
      } catch (e) { console.error('notification (folder share_downloaded) failed:', e.message); }
      emailEvents.send('share_downloaded', {
        to: share.created_by_email,
        subject: `Your shared folder was downloaded: ${share.folder_path.split('/').pop()}`,
        text: `The folder "${share.folder_path}" was just downloaded via a Depot share link you created.`,
      }).catch(() => {});
    }
    const base = share.folder_path.split('/').pop().replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.zip"`);
    // Stream (one file in memory at a time) — this is a public, unauthenticated
    // route, so buffering the whole archive would be a remote-OOM vector.
    await require('stream/promises').pipeline(zipStream(folderZipEntries(docs, share.folder_path)), res);
  } catch (e) {
    if (!res.headersSent) serverError(res, e);
    else res.destroy(e);
  }
});

// GET /api/files/folder/members?path=... — who has been granted access across a folder.
router.get('/members', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = existingFolder(req.query.path);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    // Only surface grants on files the caller can administer, and collapse the
    // per-file rows into one line per person (with how many files they can reach).
    const libraryId = await folderLibraryId(req, folderPath, req.user);
    if (!libraryId) return res.status(404).json({ error: 'Folder not found' });
    const rows = await db.query(
      `SELECT acl.subject_id,
              max(acl.subject_email) AS subject_email,
              CASE WHEN count(DISTINCT acl.permission) > 1 THEN 'mixed' ELSE max(acl.permission) END AS permission,
              count(*) AS doc_count,
              max(acl.created_at) AS created_at
       FROM document_acl acl
       JOIN documents d ON d.id = acl.document_id
       WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND d.library_id = $8 AND ${documentAccess.condition('d', 2)}
         AND lower(acl.subject_id) <> lower($${2 + documentAccess.userParams(req.user, 'admin').length})
         AND NOT (d.library_scoped AND lower(acl.subject_id) IS NOT DISTINCT FROM d.uploaded_by::text)
       GROUP BY acl.subject_id
       ORDER BY subject_email`,
      [folderPath, ...documentAccess.userParams(req.user, 'admin'), String(req.user.email || '').toLowerCase(), libraryId]
    );
    res.json({ grants: rows.map(r => ({ ...r, doc_count: Number(r.doc_count) })) });
  } catch (e) { if (folderScopeError(res, e)) return; serverError(res, e); }
});

// POST /api/files/folder/members — retired. It copied a grant onto each file in the
// folder (up to 'admin', overwriting existing grants) -- a frozen list that missed files
// added later and competed with real folder shares. Folders are shared from the library
// now (POST /api/libraries/:id/shares with a folder_path). Existing per-file grants are
// untouched and still listed and revocable here.
router.post('/members', auth, requireRole('admin', 'contributor'), (req, res) => {
  res.status(410).json({ code: 'USE_FOLDER_SHARES', error: 'Folder sharing has moved: use Share on the folder.' });
});

// DELETE /api/files/folder/members — revoke a person's access across a folder.
router.delete('/members', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = existingFolder(req.body?.path);
    const email = documentAccess.normalizeEmail(req.body?.email);
    if (!folderPath || !email) return res.status(400).json({ error: 'path and email required' });
    if (email === String(req.user.email || '').toLowerCase()) return res.status(400).json({ error: "You can't revoke your own access" });
    const libraryId = await folderLibraryId(req, folderPath, req.user);
    if (!libraryId) return res.status(404).json({ error: 'Folder not found' });
    const rows = await db.query(
      `DELETE FROM document_acl acl USING documents d
       WHERE acl.document_id = d.id AND acl.subject_type = 'user' AND lower(acl.subject_id) = lower($2)
         AND starts_with(d.name, $1 || '/') AND d.library_id = $8 AND ${documentAccess.condition('d', 3)}
       RETURNING acl.document_id`,
      [folderPath, email, ...documentAccess.userParams(req.user, 'admin'), libraryId]
    );
    await logEvent(`folder access revoke · ${folderPath} · ${email} (${rows.length})`, req.user.id, req.user.email);
    await logDocumentEvent(null, 'folder_access_revoked', req.user.id, req.user.email, `${folderPath} · ${email} (${rows.length})`);
    res.json({ ok: true, count: rows.length });
  } catch (e) { if (folderScopeError(res, e)) return; serverError(res, e); }
});

// POST /api/files/folder/copy — duplicate a folder's files into another library.
router.post('/copy', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = existingFolder(req.body?.path);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const libraryId = req.body?.library_id || (await libraries.defaultLibraryId());
    // The copies are new files in the target: the caller needs the right to add them there.
    const dest = await destinationRight(res, req.user, libraryId, folderPath);
    if (!dest) return;
    const srcLibraryId = await folderLibraryId(req, folderPath, req.user);
    if (!srcLibraryId) return res.status(404).json({ error: 'Folder not found' });
    const docs = await db.query(
      `SELECT d.id, d.name, d.mime_type, d.size, d.storage_path FROM documents d
       WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND d.name NOT LIKE '%/.keep' AND d.library_id = $7 AND ${documentAccess.condition('d', 2)}`,
      [folderPath, ...documentAccess.userParams(req.user, 'read'), srcLibraryId]
    );
    if (!docs.length) return res.status(404).json({ error: 'No files in this folder' });
    if (docs.length > FOLDER_COPY_MAX_FILES) return res.status(413).json({ error: `Too many files to copy at once (over ${FOLDER_COPY_MAX_FILES})` });
    for (const d of docs) {
      const sanitized = path.basename(d.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const newPath = `documents/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${sanitized}`;
      await storage.copy(d.storage_path, newPath, d.mime_type);
      await createDocumentRecord({ displayName: d.name, storagePath: newPath, mimetype: d.mime_type, storedSize: Number(d.size) || 0, user: req.user, sourceDetail: 'copied', libraryId, libraryScoped: dest.scoped });
    }
    await logEvent(`folder copy · ${folderPath} → library ${libraryId} (${docs.length})`, req.user.id, req.user.email);
    await logDocumentEvent(null, 'folder_copied', req.user.id, req.user.email, `${folderPath} → library ${libraryId} (${docs.length})`);
    res.json({ ok: true, count: docs.length });
  } catch (e) { if (folderScopeError(res, e)) return; console.error('folder copy failed:', e); serverError(res, e); }
});

module.exports = router;
