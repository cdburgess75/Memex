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
const folderPaths = require('../../lib/folderPaths');
const folderCarry = require('../../lib/folderCarry');
const folderPreview = require('../../lib/folderPreview');
const { keepSharedFoldersAlive } = require('../../lib/keepMarker');
const folderUndo = require('../../lib/folderUndo');

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
async function folderLibraryId(req, folderPath, user, q = db) {
  const explicit = req.headers['x-library-id'] || req.body?.source_library_id || req.query?.source_library_id;
  if (explicit) {
    if (!isUuid(explicit)) { const e = new Error('Bad library id'); e.status = 400; throw e; }
    const held = await q.queryOne(
      `SELECT 1 FROM documents d
       WHERE d.deleted_at IS NULL AND d.library_id = $1 AND starts_with(d.name, $2 || '/') AND ${documentAccess.condition('d', 3)}
       LIMIT 1`,
      [String(explicit), folderPath, ...documentAccess.userParams(user, 'read')]
    );
    return held ? String(explicit) : null;
  }
  const rows = await q.query(
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

// Renaming a folder, or moving it within its library, carries its shares along
// (lib/folderCarry.js). The two operations that would END a share -- deleting it to the
// Trash, and taking it to another library -- still refuse, because ending somebody's
// share belongs to whoever manages the library. These run INSIDE a folder operation's
// transaction, on its client, and refuse by throwing so it rolls back.
const folderSharedError = () => new FolderOpError('FOLDER_SHARED', 409,
  "This folder is shared with other people. Ask the library's owner to delete it, or stop sharing it first.");
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

// A folder path that is already too long can still be SHORTENED -- that is the only way
// out of one -- but a rename that makes it longer and pushes it past what a share can
// hold is refused, with the numbers. Silently allowing it would make the folder one
// nobody can ever share, for a reason the app never said out loud.
function tooLongToShare(oldPath, newPath, kind) {
  const chars = folderPaths.codePoints(newPath);
  const bytes = Buffer.byteLength(newPath, 'utf8');
  if (chars <= 400 && bytes <= 1024) return null;
  if (chars <= folderPaths.codePoints(oldPath) && bytes <= Buffer.byteLength(oldPath, 'utf8')) return null;
  const size = `${chars} characters (${bytes} bytes)`;
  return {
    code: 'NAME_TOO_LONG',
    error: kind === 'rename'
      ? `That name would make this folder's full path ${size} long. A folder can only be shared up to 400 characters and 1024 bytes, so please use a shorter name.`
      : `That would put this folder ${size} deep. A folder can only be shared up to 400 characters and 1024 bytes, so please move it somewhere less deep, or shorten the names on the way.`,
  };
}

// The answer the caller was shown (POST /api/access/folder-preview), checked against what
// is true now. A share added above the destination, or a group gaining a member, changes
// who this move would affect -- so the confirmation they gave was to a different question,
// and they are asked again rather than surprised.
async function refuseIfAnswerChanged(q, req, { kind, libraryId, oldPath, newPath }) {
  const sent = String(req.body?.fingerprint || '');
  if (!sent) return;
  const op = { op: kind, libraryId, path: oldPath, newPath, targetLibraryId: libraryId };
  const { before, after, carried } = await folderPreview.levelsAround(q, op);
  const now = folderPreview.fingerprint({ before, after, carried, op });
  if (now === sent) return;
  throw new FolderOpError('CHANGED', 409,
    'Who can open this folder changed while you were deciding, so this is no longer the move you were shown. Have another look.',
    { fingerprint: now });
}

/* Move a folder to a new path, with everything that belongs to it.
 *
 * This is the whole of a rename and of a move within a library; they differ only in
 * whether the folder changes parents -- and so whether the mover's own personal files
 * become library content, and whether an upload still arriving follows the folder.
 *
 * The order is the point. Nothing about a share, and nothing about what is at the
 * destination, is revealed before the right to write at that end has been proven -- and
 * every check runs on the transaction's client, under the library's tree lock, so what
 * was checked is what is written.
 */
async function carryFolder(q, { req, libraryId, oldPath, newPath, kind, dest }) {
  const user = req.user;
  // The shares that travel with the folder, held for the length of the operation: what
  // moves has to be exactly what was counted.
  const carried = await folderCarry.grantsUnder(q, libraryId, oldPath);
  await refuseIfAnswerChanged(q, req, { kind, libraryId, oldPath, newPath });
  await folderCarry.refuseIfTooBig(q, libraryId, oldPath, user.id);
  await refuseIfSomethingIsAt(q, { destLibraryId: libraryId, newPath, fromLibraryId: libraryId, fromPath: oldPath, viewer: user, verb: kind === 'rename' ? 'rename' : 'move' });
  folderCarry.planSharePaths(carried, oldPath, newPath);
  if (carried.length) await folderCarry.assertTotal(q, { libraryId, path: oldPath, user });

  /* The files. Trashed ones are deliberately included -- a folder's Trash moves with it,
   * so restoring one later lands it back inside the folder, under the share that moved
   * too -- and they are authorised by the TRASH rule, not the plain one.
   *
   * That distinction is the whole point. A folder share opens a trashed document only if
   * the share already existed when the document was deleted (documentAccess.
   * conditionInTrash). Without it, somebody holding a newer share here and an older one
   * somewhere else could move this folder under the older share and find, in their Trash,
   * files that were deleted before they had anything to do with them -- and restore them.
   * A trashed file the mover may not see therefore stays exactly where it is, which is
   * also where it was when it was deleted. On a live document the trash rule is the plain
   * rule, so nothing else changes.
   */
  const p = db.paramList();
  const old = p(oldPath);
  const np = p(newPath);
  const cut = p(folderPaths.cutFor(oldPath));
  const lib = p(libraryId);
  const rule = documentAccess.conditionInTrash('d', p.vals.length + 1);
  p.vals.push(...documentAccess.userParams(user, 'write'));
  // Moving into a shared folder makes the mover's OWN personal files library content; a
  // rename leaves the folder where it is, so nothing about scope changes.
  const scope = kind === 'reparent'
    ? `, library_scoped = d.library_scoped OR (${p(!!dest?.scoped)}::boolean AND d.uploaded_by IS NOT DISTINCT FROM ${p(user.id)})`
    : '';
  // Somebody else's personal file inside this folder is not part of it: it is theirs,
  // no share has ever reached it, and moving it would relocate a private file on their
  // behalf. It stays where they left it -- for an admin too, who could otherwise move
  // every one of them without anybody asking. What stays is counted, not named.
  const mine = p(user.id);
  const moved = await q.query(
    `UPDATE documents d SET name = ${np} || substring(d.name from ${cut}::int)${scope}
      WHERE d.library_id = ${lib}::uuid AND starts_with(d.name, ${old} || '/')
        AND (d.library_scoped OR d.uploaded_by IS NOT DISTINCT FROM ${mine}::uuid) AND ${rule}
      RETURNING d.id, d.name, (d.deleted_at IS NOT NULL) AS trashed`,
    p.vals
  );
  const state = await folderCarry.carryPathState(q, { libraryId, oldPath, newPath, kind });
  // Moving a folder out from under a shared ancestor can leave that ancestor empty, and
  // an empty shared folder is a trap: keep it.
  const kept = kind === 'reparent' ? await keepSharedFoldersAlive(q, libraryId, [`${oldPath}/`]) : [];
  const opId = await folderCarry.recordOp(q, { libraryId, kind, path: oldPath, newPath, user });
  // Anything still at the old path is somebody else's personal file: never the caller's to
  // move, never reached by a share, and still where its uploader left it. Only an admin is
  // told, matching who is shown personal files everywhere else.
  const leftBehind = await folderCarry.countUnder(q, libraryId, oldPath);
  return { opId, moved, shares: state.shares, kept, leftBehind, manages: await libraries.managesLibrary(user, libraryId, q) };
}

// After the transaction has committed: the empty objects behind any planted markers, and
// the record of what happened. All best-effort -- the move is already done, and a folder
// that moved must not be reported as a failure because a log line did not land.
async function announce(kind, { user, oldPath, newPath, out, live }) {
  try {
    for (const marker of out.kept) {
      await storage.upload(marker.storagePath, Buffer.alloc(0), 'application/octet-stream').catch(() => {});
    }
    const verb = kind === 'rename' ? 'rename' : 'move';
    await logEvent(`folder ${verb} · ${oldPath} → ${newPath}`, user.id, user.email);
    await logDocumentEvent(null, kind === 'rename' ? 'folder_renamed' : 'folder_moved', user.id, user.email,
      `${oldPath} → ${newPath} (${live})`);
    if (out.shares.length) {
      await logDocumentEvent(null, 'folder_share_moved', user.id, user.email,
        `${oldPath} → ${newPath} · ${out.shares.length} share${out.shares.length === 1 ? '' : 's'}`);
    }
  } catch (e) { console.error('folder operation committed, but recording it did not:', e.message); }
}

/* What the caller is told.
 *
 * The number of files they moved is theirs. The other three counts are about things they
 * may not be able to see for themselves -- how many shares sit at or below a folder, how
 * much of its Trash came along, and how many personal files of other people's stayed
 * behind -- so they go to whoever manages the library, and `left_behind` to admins, who
 * are shown personal files everywhere else. This is the same line the preview draws: a
 * count is a probe too.
 */
function folderOpResult(user, newPath, out) {
  const live = out.moved.filter(r => !r.trashed && !r.name.endsWith('/.keep')).length;
  return {
    body: {
      ok: true, path: newPath, op_id: out.opId, count: live,
      shares_kept: out.shares.length > 0,
      ...(out.manages ? { trashed: out.moved.filter(r => r.trashed).length, shares_moved: out.shares.length } : {}),
      ...(user.role === 'admin' ? { left_behind: out.leftBehind } : {}),
    },
    live,
  };
}

// A folder renamed to the name it already has, or moved to where it already is, is not a
// refusal and not an error -- but it must not look like a different kind of success
// either, or a client reading the counts gets undefined from a perfectly good 200.
const nothingToDo = (path) => ({ ok: true, path, op_id: null, count: 0, shares_kept: false });

// POST /api/files/folder — create an (empty) folder via a hidden .keep marker
router.post('/', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const libraryId = req.body?.library_id || (await libraries.defaultLibraryFor(req.user));
    // A new folder inside an existing (or shared) one keeps that folder's name exactly;
    // only the new part is named the way new folders are.
    const folderPath = await destinationFolder(req.body?.path, libraryId, req.user);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const dest = await destinationRight(res, req.user, libraryId, folderPath);
    if (!dest) return;
    const storagePath = `documents/${Date.now()}-keep`;
    await storage.upload(storagePath, Buffer.alloc(0), 'application/octet-stream');
    // The marker is a document placed BY NAME, so it goes in under the library's tree
    // lock, held in SHARED mode -- alongside other placements, never while a folder
    // operation is rewriting these names. The path is resolved again on that client: the
    // folder this is being created inside can have been renamed while we resolved it,
    // and the new folder would then be made at a name that folder has just vacated.
    const made = await withFolderOp({ libraryIds: [libraryId], kind: 'placement', mode: 'shared' }, async (q) => {
      const pathNow = await destinationFolder(req.body?.path, libraryId, req.user, q);
      if (!pathNow) throw new FolderOpError(null, 400, 'path required');
      const right = await writeRightOrThrow(req.user, libraryId, pathNow, q);
      const doc = await q.queryOne(
        `INSERT INTO documents (name, size, mime_type, storage_path, uploaded_by, uploaded_by_email, library_id, library_scoped)
         VALUES ($1, 0, $2, $3, $4, $5, $6, $7) RETURNING ${DOCUMENT_COLUMNS}`,
        [`${pathNow}/.keep`, 'application/octet-stream', storagePath, req.user.id, req.user.email, libraryId, right.scoped]
      );
      await documentAccess.grantOwnerAdmin(doc.id, req.user, q);
      return pathNow;
    });
    res.json({ ok: true, path: made });
  } catch (e) { if (sendFolderOpError(res, e) || folderScopeError(res, e)) return; serverError(res, e); }
});

// POST /api/files/folder/rename -- rename a folder, and everything that belongs to it
router.post('/rename', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const oldPath = existingFolder(req.body?.path);
    const rawName = String(req.body?.name || '').trim();
    if (!oldPath || !rawName) return res.status(400).json({ error: 'path and name required' });
    const newPath = folderPaths.renamedPath(oldPath, rawName);
    if (!newPath) return res.status(400).json({ error: 'invalid name' });
    const parent = folderPaths.parentOf(oldPath);
    const libraryId = await folderLibraryId(req, oldPath, req.user);
    if (!libraryId) return res.status(404).json({ error: 'Folder not found' });
    if (newPath === oldPath) return res.json(nothingToDo(oldPath)); // renamed to what it is called
    const tooLong = tooLongToShare(oldPath, newPath, 'rename');
    if (tooLong) return res.status(400).json(tooLong);
    // Renaming a folder changes its entry in the folder ABOVE it, so that is the right it
    // needs -- not a right inside the folder. Someone given Read-Write on a folder fills
    // and reorganises what is in it; its own name belongs to whoever can write where it
    // sits. Answered before anything share-shaped, so a refusal reveals nothing.
    const first = await libraries.writeRight(req.user, libraryId, parent);
    if (first.status) return res.status(first.status).json({ error: first.error });
    // Everything from here happens inside one transaction holding the library's tree
    // lock, and every check is re-run on that client: nothing may place a document by
    // name, or rename anything else in this library, while this runs.
    const out = await withFolderOp({ libraryIds: [libraryId] }, async (q) => {
      if (await folderLibraryId(req, oldPath, req.user, q) !== libraryId) throw new FolderOpError(null, 404, 'Folder not found');
      await writeRightOrThrow(req.user, libraryId, parent, q);
      const dest = await writeRightOrThrow(req.user, libraryId, newPath, q);
      return carryFolder(q, { req, libraryId, oldPath, newPath, kind: 'rename', dest });
    });
    const { body, live } = folderOpResult(req.user, newPath, out);
    await announce('rename', { user: req.user, oldPath, newPath, out, live });
    res.json(body);
  } catch (e) { if (sendFolderOpError(res, e) || folderScopeError(res, e)) return; serverError(res, e); }
});

// The people a share names, for saying whose access an operation ended. A group is named
// by its name, never by its members.
async function endedShareNames(q, ended) {
  const groupIds = [...new Set(ended.filter(e => e.group_id).map(e => String(e.group_id)))];
  const names = new Map();
  if (groupIds.length) {
    for (const g of await q.query('SELECT id, name FROM groups WHERE id = ANY($1::uuid[])', [groupIds])) {
      names.set(String(g.id), g.name);
    }
  }
  return ended.map(e => ({
    path: e.folder_path,
    permission: e.permission,
    subject_type: e.subject_type,
    subject: e.subject_type === 'group' ? (names.get(String(e.group_id)) || 'a group') : e.subject_email,
  }));
}

/* POST /api/files/folder/delete -- move a whole folder to the Trash.
 *
 * Deleting a folder ENDS whatever it was shared with, which is why this one is not the
 * mirror of a rename. A share is keyed by a path, and a path with nothing under it is a
 * trap; the access rule has no notion of "deleted", so leaving the shares in place would
 * also leave Read-Write holders with write on trashed content at a name that is gone.
 *
 * So the shares end -- and are written down, with the files they covered, so the whole
 * thing can be put back for as long as the window lasts.
 */
router.post('/delete', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = existingFolder(req.body?.path);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const libraryId = await folderLibraryId(req, folderPath, req.user);
    if (!libraryId) return res.status(404).json({ error: 'Folder not found' });
    // Deleting a folder changes the folder ABOVE it, so that is the right it needs --
    // until now this route asked for no right at all, which left a Read-Write recipient
    // able to trash the very folder that had been shared with them.
    const parent = folderPaths.parentOf(folderPath);
    const first = await libraries.writeRight(req.user, libraryId, parent);
    if (first.status) return res.status(first.status).json({ error: first.error });
    const out = await withFolderOp({ libraryIds: [libraryId] }, async (q) => {
      if (await folderLibraryId(req, folderPath, req.user, q) !== libraryId) throw new FolderOpError(null, 404, 'Folder not found');
      await writeRightOrThrow(req.user, libraryId, parent, q);
      const carried = await folderCarry.grantsUnder(q, libraryId, folderPath);
      // Ending somebody else's access is the library owner's to do.
      if (carried.length && !(await libraries.managesLibrary(req.user, libraryId, q))) {
        throw new FolderOpError('FOLDER_MANAGER_ONLY', 403,
          "This folder is shared with other people. Deleting it would end that sharing, so it belongs to whoever owns this library.");
      }
      await folderCarry.refuseIfTooBig(q, libraryId, folderPath, req.user.id);
      const opId = await folderCarry.recordOp(q, {
        libraryId, kind: 'delete', path: folderPath, user: req.user,
        expiresAt: new Date(Date.now() + folderUndo.windowMinutes() * 60000),
      });
      const p = db.paramList();
      const lib = p(libraryId);
      const fp = p(folderPath);
      const by = p(req.user.id);
      const byEmail = p(req.user.email);
      const rule = documentAccess.condition('d', p.vals.length + 1);
      p.vals.push(...documentAccess.userParams(req.user, 'write'));
      // Somebody else's personal file inside this folder is theirs, and no share ever
      // reached it: it stays where they left it, as it does on a rename.
      const trashed = await q.query(
        `UPDATE documents d SET deleted_at = NOW(), deleted_by = ${by}::uuid, deleted_by_email = ${byEmail}
          WHERE d.library_id = ${lib}::uuid AND starts_with(d.name, ${fp} || '/') AND d.deleted_at IS NULL
            AND (d.library_scoped OR d.uploaded_by IS NOT DISTINCT FROM ${by}::uuid) AND ${rule}
          RETURNING d.id, d.name`,
        p.vals
      );
      await folderCarry.recordOpDocuments(q, opId, trashed.map(r => r.id));
      const ended = await folderCarry.endShares(q, { libraryId, path: folderPath, opId, user: req.user, cause: 'folder_deleted' });
      // A folder deleted out of a shared ancestor can leave that ancestor empty.
      const kept = await keepSharedFoldersAlive(q, libraryId, [`${folderPath}/`]);
      const leftBehind = await folderCarry.countUnder(q, libraryId, folderPath, { liveOnly: true });
      return { opId, trashed, ended: await endedShareNames(q, ended), kept, leftBehind };
    });
    for (const marker of out.kept) await storage.upload(marker.storagePath, Buffer.alloc(0), 'application/octet-stream').catch(() => {});
    const count = out.trashed.filter(r => !r.name.endsWith('/.keep')).length;
    try {
      await logEvent(`folder trash · ${folderPath} (${count})`, req.user.id, req.user.email);
      await logDocumentEvent(null, 'folder_trashed', req.user.id, req.user.email, `${folderPath} (${count})`);
      if (out.ended.length) {
        await logDocumentEvent(null, 'library_unshared', req.user.id, req.user.email,
          `${folderPath} · ${out.ended.length} share${out.ended.length === 1 ? '' : 's'} ended by deleting the folder (op ${out.opId})`);
      }
    } catch (e) { console.error('folder deleted, but recording it did not:', e.message); }
    res.json({
      ok: true, op_id: out.opId, count,
      shares_ended: out.ended,
      undo_until: new Date(Date.now() + folderUndo.windowMinutes() * 60000).toISOString(),
      ...(req.user.role === 'admin' ? { left_behind: out.leftBehind } : {}),
    });
  } catch (e) { if (sendFolderOpError(res, e) || folderScopeError(res, e)) return; serverError(res, e); }
});

/* POST /api/files/folder/restore -- undo one folder deletion, by its id and nothing else.
 *
 * The files and the shares both come from the operation's own record. A list of ids from
 * the caller would let one deletion's id be paired with somebody else's files, and would
 * make the window a fiction the moment a page was reloaded.
 */
router.post('/restore', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const opId = String(req.body?.op_id || '');
    if (!isUuid(opId)) return res.status(400).json({ error: 'op_id required' });
    const op = await folderUndo.opRow(db, opId);
    if (!op || op.kind !== 'delete') return res.status(404).json({ error: 'That deletion could not be found.' });
    // The right the deletion itself needed: write where the folder sat -- and, when it
    // ended somebody's sharing, the library to be yours to manage, because putting that
    // sharing back is the same decision as ending it.
    const parent = folderPaths.parentOf(op.path);
    const right = await libraries.writeRight(req.user, op.library_id, parent);
    if (right.status) return res.status(right.status).json({ error: right.error });
    const out = await withFolderOp({ libraryIds: [op.library_id] }, async (q) => {
      await writeRightOrThrow(req.user, op.library_id, parent, q);
      const endedAny = await q.queryOne('SELECT EXISTS (SELECT 1 FROM library_grants_ended WHERE op_id = $1) AS any', [opId]);
      if (endedAny?.any && !(await libraries.managesLibrary(req.user, op.library_id, q))) {
        throw new FolderOpError('FOLDER_MANAGER_ONLY', 403,
          "This folder was shared when it was deleted, so putting it back is for whoever owns this library.");
      }
      return folderUndo.undo(q, { opId, user: req.user });
    });
    if (!out.already) {
      try {
        await logEvent(`folder restore · ${op.path} (${out.documents.length})`, req.user.id, req.user.email);
        await logDocumentEvent(null, 'folder_restored', req.user.id, req.user.email,
          `${op.path} (${out.documents.length}, ${out.shares.length} share${out.shares.length === 1 ? '' : 's'} back) (op ${opId})`);
      } catch (e) { console.error('folder restored, but recording it did not:', e.message); }
    }
    res.json({
      ok: true, path: op.path, already_undone: out.already,
      // the same kind of number the deletion reported: files, not the hidden markers
      // that keep an empty shared folder alive
      count: out.documents.filter(d => !d.name.endsWith('/.keep')).length,
      shares_restored: await endedShareNames({ query: (sql, params) => db.query(sql, params) }, out.shares),
      shares_not_restored: out.missed.map(m => ({ path: m.folder_path, permission: m.permission, reason: m.reason })),
    });
  } catch (e) { if (sendFolderOpError(res, e) || folderScopeError(res, e)) return; serverError(res, e); }
});

/* POST /api/files/folder/purge-trashed -- empty one folder's Trash for good.
 *
 * A folder deleted to the Trash keeps its name for the whole retention window, so it goes
 * on blocking anything else being called that -- and the only other way out was to wait a
 * month or find an admin willing to purge files one at a time. This is the remedy the
 * refusal points at, and it belongs to whoever manages the library.
 */
router.post('/purge-trashed', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = existingFolder(req.body?.path);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    const libraryId = req.body?.library_id || req.headers['x-library-id'] || req.body?.source_library_id;
    if (!isUuid(String(libraryId || ''))) return res.status(400).json({ error: 'Bad library id' });
    if (!(await libraries.managesLibrary(req.user, libraryId))) {
      return res.status(403).json({ error: "Emptying a folder's Trash for good is for whoever owns this library." });
    }
    const gone = await withFolderOp({ libraryIds: [String(libraryId)] }, async (q) => {
      if (!(await libraries.managesLibrary(req.user, libraryId, q))) throw new FolderOpError(null, 403, 'Not yours to empty.');
      // Every version's object is read BEFORE the delete: document_versions CASCADEs, so
      // afterwards there is nothing left to say which objects to remove, and they would
      // sit in storage forever.
      const paths = await q.query(
        `SELECT d.storage_path FROM documents d
          WHERE d.library_id = $1 AND starts_with(d.name, $2 || '/') AND d.deleted_at IS NOT NULL AND d.library_scoped
          UNION ALL
         SELECT v.storage_path FROM document_versions v
          WHERE v.document_id IN (SELECT d.id FROM documents d
                                   WHERE d.library_id = $1 AND starts_with(d.name, $2 || '/')
                                     AND d.deleted_at IS NOT NULL AND d.library_scoped)`,
        [libraryId, folderPath]
      );
      const rows = await q.query(
        `DELETE FROM documents d
          WHERE d.library_id = $1 AND starts_with(d.name, $2 || '/') AND d.deleted_at IS NOT NULL AND d.library_scoped
          RETURNING d.id`,
        [libraryId, folderPath]
      );
      return { count: rows.length, objects: paths.map(p => p.storage_path).filter(Boolean) };
    });
    // After the commit: a crash here leaves objects nobody points at, which the access
    // self-check counts, rather than rows pointing at objects that are already gone.
    for (const objectPath of gone.objects) await storage.del(objectPath).catch(() => {});
    try {
      await logEvent(`folder purge · ${folderPath} (${gone.count})`, req.user.id, req.user.email);
      await logDocumentEvent(null, 'folder_purged', req.user.id, req.user.email, `${folderPath} (${gone.count})`);
    } catch (e) { console.error('folder purged, but recording it did not:', e.message); }
    res.json({ ok: true, count: gone.count });
  } catch (e) { if (sendFolderOpError(res, e) || folderScopeError(res, e)) return; serverError(res, e); }
});

// POST /api/files/folder/reparent -- move a folder under a different parent (drag-drop)
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
    const newPath = target ? `${target}/${folderPaths.baseOf(oldPath)}` : folderPaths.baseOf(oldPath);
    if (newPath === oldPath) return res.json(nothingToDo(oldPath)); // already there
    if (folderPaths.movesIntoItself(oldPath, target)) return res.status(400).json({ error: "Can't move a folder into itself" });
    const tooDeep = tooLongToShare(oldPath, newPath, 'reparent');
    if (tooDeep) return res.status(400).json(tooDeep);
    // Moving a folder needs the right at BOTH ends: where it is now (its name and place
    // belong to the folder above it) and where it is going (dragging a folder into a
    // shared folder must not quietly share it with everyone who has access there).
    const parent = folderPaths.parentOf(oldPath);
    const first = await libraries.writeRight(req.user, srcLibraryId, parent);
    if (first.status) return res.status(first.status).json({ error: first.error });
    const out = await withFolderOp({ libraryIds: [srcLibraryId] }, async (q) => {
      if (await folderLibraryId(req, oldPath, req.user, q) !== srcLibraryId) throw new FolderOpError(null, 404, 'Folder not found');
      await writeRightOrThrow(req.user, srcLibraryId, parent, q);
      const dest = await writeRightOrThrow(req.user, srcLibraryId, newPath, q);
      return carryFolder(q, { req, libraryId: srcLibraryId, oldPath, newPath, kind: 'reparent', dest });
    });
    const { body, live } = folderOpResult(req.user, newPath, out);
    await announce('reparent', { user: req.user, oldPath, newPath, out, live });
    res.json(body);
  } catch (e) { if (sendFolderOpError(res, e) || folderScopeError(res, e)) return; serverError(res, e); }
});

// POST /api/files/folder/move — move a folder's contents to another library
router.post('/move', auth, requireRole('admin', 'contributor'), async (req, res) => {
  try {
    const folderPath = existingFolder(req.body?.path);
    if (!folderPath) return res.status(400).json({ error: 'path required' });
    // Nobody said where to move it: their OWN library, never the install's oldest --
    // which on every box is the one Depot seeds, i.e. the shared one. Nothing is shared
    // with anybody by forgetting to choose.
    const libraryId = req.body?.library_id || (await libraries.defaultLibraryFor(req.user));
    // The destination must be a library the caller can add files to, at this path
    // (writeRight: 400 for a malformed id, 404 for an unknown one, 403 without a right).
    // documents.library_id has no foreign key, so without this a document could be
    // stamped with a library nobody can reach and drop out of every listing.
    const dest0 = await destinationRight(res, req.user, libraryId, folderPath);
    if (!dest0) return;
    const srcLibraryId = await folderLibraryId(req, folderPath, req.user);
    if (!srcLibraryId) return res.status(404).json({ error: 'Folder not found' });
    // Both libraries are locked, in key order, so a move each way cannot deadlock.
    const out = await withFolderOp({ libraryIds: [srcLibraryId, libraryId] }, async (q) => {
      const dest = await writeRightOrThrow(req.user, libraryId, folderPath, q);
      if (String(srcLibraryId) !== String(libraryId)) {
        await refuseIfSomethingIsAt(q, { destLibraryId: libraryId, newPath: folderPath, fromLibraryId: srcLibraryId, fromPath: folderPath, viewer: req.user, verb: 'move' });
      }
      // Sharing belongs to the library it was made in, and to that library's owner. A
      // folder taken to ANOTHER library therefore leaves its shares behind -- they END,
      // they do not travel -- which is a decision only whoever manages the source may make.
      const carried = await folderCarry.grantsUnder(q, srcLibraryId, folderPath);
      const managesSource = await libraries.managesLibrary(req.user, srcLibraryId, q);
      if (carried.length && !managesSource) {
        throw new FolderOpError('FOLDER_MANAGER_ONLY', 403,
          "This folder is shared with other people. Taking it to another library ends that sharing, so it belongs to whoever owns this library.");
      }
      // Library content belongs to its library: taking it to ANOTHER library hands it to
      // that library's owner, so only whoever manages the source may, and never into a
      // library held only under the old open rule ($11). Anyone else's move leaves it
      // where it is, counted (kept) so the app can say why -- they can still copy it.
      const contentMoves = String(srcLibraryId) === String(libraryId) || (managesSource && dest.right !== 'legacy');
      // When shares are ending, the folder's Trash goes too: otherwise "nothing is left
      // here" is never true, and the shares could never end cleanly.
      const withTrash = carried.length > 0 && contentMoves;
      const p = db.paramList();
      const fp = p(folderPath);
      const toLib = p(libraryId);
      const rule = documentAccess.condition('d', p.vals.length + 1);
      p.vals.push(...documentAccess.userParams(req.user, 'write'));
      const src = p(srcLibraryId);
      const scoped = p(dest.scoped);
      const me = p(req.user.id);
      const moves = p(contentMoves);
      const moved = await q.query(
        `UPDATE documents d SET library_id = ${toLib}::uuid,
                library_scoped = d.library_scoped OR (${scoped}::boolean AND d.uploaded_by IS NOT DISTINCT FROM ${me}::uuid)
          WHERE d.library_id = ${src}::uuid AND starts_with(d.name, ${fp} || '/')
            AND (${withTrash ? 'TRUE' : 'd.deleted_at IS NULL'})
            AND ${rule} AND (NOT d.library_scoped OR ${moves}::boolean)
          RETURNING d.id`,
        p.vals
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
      // The shares end only once nothing of the library's own is left under that name --
      // while content stays, the shares still cover something and must stay with it.
      let ended = [];
      let opId = null;
      if (carried.length) {
        const remaining = await folderCarry.countUnder(q, srcLibraryId, folderPath);
        if (!remaining) {
          opId = await folderCarry.recordOp(q, {
            libraryId: srcLibraryId, targetLibraryId: libraryId, kind: 'library_move', path: folderPath,
            newPath: folderPath, user: req.user,
          });
          ended = await folderCarry.endShares(q, { libraryId: srcLibraryId, path: folderPath, opId, user: req.user, cause: 'moved_to_library' });
        }
      }
      // What people asked to hear about follows the folder into its new library.
      if (String(srcLibraryId) !== String(libraryId)) {
        await folderCarry.carryNotifyPrefs(q, { libraryId: srcLibraryId, destLibraryId: libraryId, oldPath: folderPath, newPath: folderPath });
      }
      const kept = await keepSharedFoldersAlive(q, srcLibraryId, [`${folderPath}/`]);
      return { rows: moved, kept: left, ended: await endedShareNames(q, ended), opId, markers: kept };
    });
    for (const marker of out.markers) await storage.upload(marker.storagePath, Buffer.alloc(0), 'application/octet-stream').catch(() => {});
    try {
      await logEvent(`folder move to library · ${folderPath} → ${libraryId} (${out.rows.length})`, req.user.id, req.user.email);
      await logDocumentEvent(null, 'folder_moved_library', req.user.id, req.user.email, `${folderPath} → library ${libraryId} (${out.rows.length}${out.kept ? `, ${out.kept} kept` : ''})`);
      if (out.ended.length) {
        await logDocumentEvent(null, 'library_unshared', req.user.id, req.user.email,
          `${folderPath} · ${out.ended.length} share${out.ended.length === 1 ? '' : 's'} ended by moving the folder to another library (op ${out.opId})`);
      }
    } catch (e) { console.error('folder moved, but recording it did not:', e.message); }
    res.json({ ok: true, count: out.rows.length, kept: out.kept, ...(out.ended.length ? { op_id: out.opId, shares_ended: out.ended } : {}) });
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
// The names inside the archive, taken from where each document IS now. A link holds a
// frozen list of document ids and a folder path that is only a label -- and the folder
// can be renamed or moved after the link is made, which the link is meant to survive. So
// a document that no longer sits under the label falls back to its own file name rather
// than being cut by a length that no longer means anything (which produced entries like
// "er/tax.pdf", or bare ".pdf" collisions).
function folderZipEntries(docs, folderPath) {
  const parent = folderPath.split('/').slice(0, -1).join('/');
  const pre = parent ? `${parent}/` : '';
  return docs.map(d => ({
    name: pre && d.name.startsWith(pre) ? d.name.slice(pre.length) : (pre ? folderPaths.baseOf(d.name) : d.name),
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
    // A link's folder_path is a label, frozen when it was made; what it actually serves
    // is a list of document ids. So a link belongs to this folder if its label says so
    // OR if any document it serves lives here now -- which is how a link stays findable,
    // and revocable, after the folder it came from is renamed or moved.
    const libraryId = await folderLibraryId(req, folderPath, req.user);
    const rows = await db.query(
      `SELECT l.id, l.folder_path, l.document_ids, l.expires_at, l.revoked_at, l.created_at,
              l.created_by_email, l.last_accessed_at, l.access_count, l.password_hash
       FROM folder_share_links l
       WHERE (l.folder_path = ANY($1::text[])
              OR ($3::uuid IS NOT NULL AND EXISTS (
                    SELECT 1 FROM documents d
                     WHERE d.id = ANY(l.document_ids) AND d.library_id = $3::uuid
                       AND d.deleted_at IS NULL AND starts_with(d.name, $4 || '/'))))
         ${adminAll ? '' : 'AND l.created_by = $2'}
       ORDER BY l.revoked_at IS NULL DESC, l.created_at DESC
       LIMIT 100`,
      adminAll ? [keys, null, libraryId, folderPath] : [keys, req.user.id, libraryId, folderPath]
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
    // As with a move: unsaid means their own library, not the shared one.
    const libraryId = req.body?.library_id || (await libraries.defaultLibraryFor(req.user));
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
  } catch (e) { if (sendFolderOpError(res, e) || folderScopeError(res, e)) return; console.error('folder copy failed:', e); serverError(res, e); }
});

module.exports = router;
