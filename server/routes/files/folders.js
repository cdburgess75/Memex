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

// POST /api/files/folder — create an (empty) folder via a hidden .keep marker
router.post('/', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = safeDocName(req.body?.path, '');
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const markerName = `${folderPath}/.keep`;
    const storagePath = `documents/${Date.now()}-keep`;
    await storage.upload(storagePath, Buffer.alloc(0), 'application/octet-stream');
    const doc = await db.queryOne(
      `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id)
       VALUES ($1, 0, $2, $3, $4, $5, $6) RETURNING ${DOCUMENT_COLUMNS}`,
      [markerName, 'application/octet-stream', storagePath, req.user.id, req.user.email, req.body?.library_id || (await libraries.defaultLibraryId())]
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
    const rows = await db.query(
      `UPDATE documents d SET name = $2 || substring(d.name from $3::int)
       WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND d.library_id = $9 AND ${documentAccess.condition('d', 4)}
       RETURNING d.id`,
      // substring() counts characters, and JavaScript's .length counts UTF-16 units, so
      // a folder name with an emoji in it would otherwise be cut one character short.
      [oldPath, newPath, Array.from(oldPath).length + 1, ...documentAccess.userParams(req.user, 'write'), libraryId]
    );
    await logEvent(`folder rename · ${oldPath} → ${newPath}`, req.user.id, req.user.email);
    await logDocumentEvent(null, 'folder_renamed', req.user.id, req.user.email, `${oldPath} → ${newPath} (${rows.length})`);
    res.json({ ok: true, path: newPath, count: rows.length });
  } catch (e) { if (folderScopeError(res, e)) return; serverError(res, e); }
});

// POST /api/files/folder/delete — move a whole folder's contents to Trash
router.post('/delete', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = existingFolder(req.body?.path);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const libraryId = await folderLibraryId(req, folderPath, req.user);
    if (!libraryId) return res.status(404).json({ error: 'Folder not found' });
    const rows = await db.query(
      `UPDATE documents d SET deleted_at = NOW(), deleted_by = $2, deleted_by_email = $3
       WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND d.library_id = $9 AND ${documentAccess.condition('d', 4)}
       RETURNING d.id`,
      [folderPath, req.user.id, req.user.email, ...documentAccess.userParams(req.user, 'write'), libraryId]
    );
    await logEvent(`folder trash · ${folderPath} (${rows.length})`, req.user.id, req.user.email);
    await logDocumentEvent(null, 'folder_trashed', req.user.id, req.user.email, `${folderPath} (${rows.length})`);
    res.json({ ok: true, count: rows.length });
  } catch (e) { if (folderScopeError(res, e)) return; serverError(res, e); }
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
    const rows = await db.query(
      `UPDATE documents d SET name = $2 || substring(d.name from $3::int)
       WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND d.library_id = $9 AND ${documentAccess.condition('d', 4)}
       RETURNING d.id`,
      [oldPath, newPath, Array.from(oldPath).length + 1, ...documentAccess.userParams(req.user, 'write'), srcLibraryId]
    );
    await logEvent(`folder move · ${oldPath} → ${newPath}`, req.user.id, req.user.email);
    await logDocumentEvent(null, 'folder_moved', req.user.id, req.user.email, `${oldPath} → ${newPath} (${rows.length})`);
    res.json({ ok: true, path: newPath, count: rows.length });
  } catch (e) { if (folderScopeError(res, e)) return; serverError(res, e); }
});

// POST /api/files/folder/move — move a folder's contents to another library
router.post('/move', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = existingFolder(req.body?.path);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const libraryId = req.body?.library_id || (await libraries.defaultLibraryId());
    // The two sibling transfers both check the destination (/folder/copy below and
    // /api/files/library-transfer); this one did not, and documents.library_id has
    // no foreign key, so any uuid was accepted. A document stamped with a library
    // the caller cannot reach — or one that does not exist — drops out of every
    // library-scoped listing and out of every folder operation, which since the
    // folder queries became library-scoped is the whole of them. canAccessLibrary
    // returns false for an unknown id, so this covers the bogus-uuid case too.
    if (!(await libraries.canAccessLibrary(req.user, libraryId))) return res.status(403).json({ error: 'no access to target library' });
    const srcLibraryId = await folderLibraryId(req, folderPath, req.user);
    if (!srcLibraryId) return res.status(404).json({ error: 'Folder not found' });
    const rows = await db.query(
      `UPDATE documents d SET library_id = $2
       WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND d.library_id = $8 AND ${documentAccess.condition('d', 3)}
       RETURNING d.id`,
      [folderPath, libraryId, ...documentAccess.userParams(req.user, 'write'), srcLibraryId]
    );
    await logEvent(`folder move to library · ${folderPath} → ${libraryId} (${rows.length})`, req.user.id, req.user.email);
    await logDocumentEvent(null, 'folder_moved_library', req.user.id, req.user.email, `${folderPath} → library ${libraryId} (${rows.length})`);
    res.json({ ok: true, count: rows.length });
  } catch (e) { if (folderScopeError(res, e)) return; serverError(res, e); }
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

// DELETE /api/files/folder/links/:shareId — revoke a folder download link.
router.delete('/links/:shareId', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const adminAll = (req.user.role === 'admin');
    const share = await db.queryOne(
      `UPDATE folder_share_links
       SET revoked_at = NOW(), revoked_by = $1, revoked_by_email = $2
       WHERE id = $3 AND revoked_at IS NULL ${adminAll ? '' : 'AND created_by = $4'}
       RETURNING id, folder_path`,
      adminAll ? [req.user.id, req.user.email, req.params.shareId] : [req.user.id, req.user.email, req.params.shareId, req.user.id]
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
    const creator = await documentAccess.resolveActor(share.created_by);
    if (!creator || (creator.role !== 'admin' && creator.role !== 'contributor')) {
      return res.status(404).json({ error: 'Share link not found' });
    }
    const ids = Array.isArray(share.document_ids) ? share.document_ids : [];
    const docs = ids.length ? await db.query(
      `SELECT d.id, d.name, d.storage_path, d.size FROM documents d
       WHERE d.id = ANY($1::uuid[]) AND d.deleted_at IS NULL AND ${documentAccess.condition('d', 2)}
       ORDER BY d.name`,
      [ids, ...documentAccess.userParams(creator, 'write')]
    ) : [];
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
       GROUP BY acl.subject_id
       ORDER BY subject_email`,
      [folderPath, ...documentAccess.userParams(req.user, 'admin'), String(req.user.email || '').toLowerCase(), libraryId]
    );
    res.json({ grants: rows.map(r => ({ ...r, doc_count: Number(r.doc_count) })) });
  } catch (e) { if (folderScopeError(res, e)) return; serverError(res, e); }
});

// POST /api/files/folder/members — grant one person access to every file in a folder.
router.post('/members', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = existingFolder(req.body?.path);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const email = documentAccess.normalizeEmail(req.body?.email);
    // Reject anything that isn't a plain address (no quotes/spaces/angle brackets) —
    // defense in depth so a crafted value can't ride into the UI or outbound mail.
    if (!/^[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+$/.test(email)) return res.status(400).json({ error: 'Valid user email is required' });
    const permission = req.body?.permission || 'read';
    if (!documentAccess.validPermission(permission)) return res.status(400).json({ error: 'Permission must be read, write, or admin' });
    // Only files the caller administers; skip the folder marker.
    const libraryId = await folderLibraryId(req, folderPath, req.user);
    if (!libraryId) return res.status(404).json({ error: 'Folder not found' });
    const rows = await db.query(
      `INSERT INTO document_acl (document_id, subject_type, subject_id, subject_email, permission, granted_by, granted_by_email)
       SELECT d.id, 'user', $2, $2, $3, $4, $5 FROM documents d
       WHERE d.deleted_at IS NULL AND starts_with(d.name, $1 || '/') AND d.name NOT LIKE '%/.keep'
         AND d.library_id = $11 AND ${documentAccess.condition('d', 6)}
       ON CONFLICT (document_id, subject_type, subject_id)
       DO UPDATE SET permission = EXCLUDED.permission, subject_email = EXCLUDED.subject_email,
                     granted_by = EXCLUDED.granted_by, granted_by_email = EXCLUDED.granted_by_email
       RETURNING document_id`,
      [folderPath, email, permission, req.user.id, String(req.user.email || '').toLowerCase(), ...documentAccess.userParams(req.user, 'admin'), libraryId]
    );
    if (!rows.length) return res.status(404).json({ error: 'No files you manage in this folder' });
    await logEvent(`folder access grant · ${folderPath} · ${email} · ${permission} (${rows.length})`, req.user.id, req.user.email);
    await logDocumentEvent(null, 'folder_access_granted', req.user.id, req.user.email, `${folderPath} · ${email} · ${permission} (${rows.length})`);
    if (email !== String(req.user.email || '').toLowerCase()) {
      const folderName = folderPath.split('/').pop();
      try {
        await notifications.create({
          userEmail: email,
          type: 'share_granted',
          title: `${req.user.email} shared a folder with you`,
          body: `"${folderName}" · ${rows.length} file${rows.length === 1 ? '' : 's'} · ${permission} access`,
        });
      } catch (e) { console.error('notification (folder share_granted) failed:', e.message); }
      emailEvents.send('share_granted', {
        to: email,
        subject: `${req.user.email} shared a folder with you`,
        text: `${req.user.email} gave you ${permission} access to the folder "${folderPath}" (${rows.length} files) in Depot.\n\nSign in to Depot to open it.`,
        actorEmail: req.user.email,
      }).catch(() => {});
    }
    res.json({ ok: true, count: rows.length, permission });
  } catch (e) { if (folderScopeError(res, e)) return; serverError(res, e); }
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
    if (!(await libraries.canAccessLibrary(req.user, libraryId))) return res.status(403).json({ error: 'no access to target library' });
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
      await createDocumentRecord({ displayName: d.name, storagePath: newPath, mimetype: d.mime_type, storedSize: Number(d.size) || 0, user: req.user, sourceDetail: 'copied', libraryId });
    }
    await logEvent(`folder copy · ${folderPath} → library ${libraryId} (${docs.length})`, req.user.id, req.user.email);
    await logDocumentEvent(null, 'folder_copied', req.user.id, req.user.email, `${folderPath} → library ${libraryId} (${docs.length})`);
    res.json({ ok: true, count: docs.length });
  } catch (e) { if (folderScopeError(res, e)) return; console.error('folder copy failed:', e); serverError(res, e); }
});

module.exports = router;
