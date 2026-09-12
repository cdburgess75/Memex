'use strict';
// What travels with a folder, besides its files.
//
// A folder is only a name prefix, so moving one is a rewrite: every document under it,
// every share attached to it, every notification someone asked for on it, and any upload
// still arriving into it. Doing the files and leaving the rest behind is what orphaned a
// share on the old name -- the reason renaming a shared folder was refused until now.
//
// Everything here runs INSIDE a folder operation's transaction, on its client, while the
// library's tree lock is held (lib/folderOps.js). The checks throw FolderOpError, so a
// refusal rolls the whole thing back and leaves nothing half-moved.
//
// This module is the seam: when documents gain a real folder_id and folders become rows,
// the documents rewrite collapses to one row and the rest of this file disappears.
const db = require('./db');
const documentAccess = require('./documentAccess');
const folderPaths = require('./folderPaths');
const { FolderOpError } = require('./folderOps');
const { prefixRange, canonicalFolderPath } = require('./documents');

// How much one operation may rewrite. A folder far bigger than this is rewritten by
// hand, out of hours: doing it inside a request would hold the library's tree lock long
// enough to stop everyone else working, and the person waiting would see a timeout with
// nothing to do about it. The number is a row count, not a size -- the work is per name.
const maxRows = () => Number(process.env.FOLDER_OP_MAX_ROWS || 50000);

// The shares at the folder or anywhere under it: the ones that travel with it. Locked,
// because what moves has to be exactly what was counted -- a share created against this
// path while the operation runs waits here and then finds the folder already gone.
// Shares ABOVE are not touched: they cover wherever the folder lands, or they don't.
async function grantsUnder(q, libraryId, path) {
  if (!path) return [];
  return q.query(
    `SELECT g.id, g.folder_path, g.subject_type, g.subject_email, g.group_id, g.permission
       FROM library_grants g
      WHERE g.library_id = $1 AND g.folder_path <> ''
        AND (g.folder_path = $2 OR starts_with(g.folder_path, $2 || '/'))
      ORDER BY g.folder_path, g.id
      FOR UPDATE`,
    [libraryId, path]
  );
}

// How many documents are under the path, trashed ones included by default: a rename moves
// those too. `mover` counts only what would actually be rewritten -- somebody else's
// personal file stays where it is, so it is neither work to do nor a number to quote at
// anyone. `liveOnly` is for afterwards: what is still sitting there.
async function countUnder(q, libraryId, path, { mover = null, liveOnly = false } = {}) {
  const row = await q.queryOne(
    `SELECT count(*)::int AS n FROM documents d
      WHERE d.library_id = $1 AND ${prefixRange('d', '$2')}
        AND ($3::uuid IS NULL OR d.library_scoped OR d.uploaded_by IS NOT DISTINCT FROM $3::uuid)
        AND ($4::boolean IS NOT TRUE OR d.deleted_at IS NULL)`,
    [libraryId, path, mover, liveOnly]
  );
  return row ? row.n : 0;
}

// Refuse before anything is written, with the real number: "too big" is only useful if
// it says how big.
async function refuseIfTooBig(q, libraryId, path, mover) {
  const max = maxRows();
  const n = await countUnder(q, libraryId, path, { mover });
  if (n > max) {
    throw new FolderOpError('FOLDER_TOO_LARGE', 409,
      `This folder holds ${n.toLocaleString('en-GB')} files, counting what is in its Trash -- more than the ${max.toLocaleString('en-GB')} one move can rewrite at once. Move some of what is inside it first, or ask an admin.`,
      { count: n, max });
  }
  return n;
}

// Where each carried share would end up, checked against the shape a share path must
// have (documents.canonicalFolderPath -- the same rules as library_grants' own CHECK).
// A path that is too long or malformed cannot hold a share, so the move would break the
// share rather than carry it: refuse, and say which one.
function planSharePaths(grants, oldPath, newPath) {
  const bad = [];
  const moved = grants.map((g) => {
    const to = folderPaths.rekey(g.folder_path, oldPath, newPath);
    if (canonicalFolderPath(to) !== to) bad.push({ from: g.folder_path, to });
    return { ...g, new_path: to };
  });
  if (grants.length && canonicalFolderPath(newPath) !== newPath) bad.push({ from: oldPath, to: newPath });
  if (bad.length) {
    throw new FolderOpError('SHARE_PATH_INVALID', 409,
      'This folder is shared, and the new name would make the shared path too long to keep. Choose a shorter name, or move it somewhere less deep.',
      { paths: bad.slice(0, 5).map(b => b.to) });
  }
  return moved;
}

// Invariant T, as an assertion. When shares travel, ALL the LIVE library content under
// the folder has to travel with them -- half a folder moving would silently strip the
// share from the other half. The right that authorises the operation (libraries.
// writeRight) always covers the whole subtree, so this cannot fire; it runs anyway,
// because an argument that is checked every time is worth more than one that is only
// written down.
//
// Live content only, deliberately. A trashed file the mover may not see stays where it
// was deleted (see the rewrite in routes/files/folders.js), and that is not a split: it
// is not shown to anyone new, and the share that used to cover it went with the folder.
//
// Runs BEFORE the documents are rewritten: afterwards the moved rows would look like
// strangers to a path that no longer exists. `IS NOT TRUE`, not NOT: the rule is NULL,
// not false, for a row with no uploader read by a caller with no id.
async function assertTotal(q, { libraryId, path, user }) {
  const p = db.paramList();
  const lib = p(libraryId);
  const old = p(path);
  // The same rule the rewrite uses, trash guard and all, so what this asserts is exactly
  // what would move.
  const rule = documentAccess.conditionInTrash('d', p.vals.length + 1);
  p.vals.push(...documentAccess.userParams(user, 'write'));
  const row = await q.queryOne(
    `SELECT EXISTS (SELECT 1 FROM documents d
                     WHERE d.library_id = ${lib}::uuid AND d.library_scoped AND d.deleted_at IS NULL
                       AND ${prefixRange('d', old)}
                       AND (${rule}) IS NOT TRUE) AS partial`,
    p.vals
  );
  if (row?.partial) {
    console.error(`INVARIANT T: ${path} in library ${libraryId} holds library content ${user?.email || 'the caller'} cannot change, so its shares cannot move with it`);
    throw new FolderOpError('FOLDER_PARTIAL', 409,
      "Some files here belong to the library and you can't change them, so this folder can't be moved as a whole. Ask the library's owner to move it.");
  }
}

// The constraints that back the checks up. planSharePaths and the exclusivity check make
// them unreachable, so reaching one is a bug -- but a refusal that says what happened
// beats a 500 that doesn't, and the operation rolled back either way. Deliberately NOT
// in sendFolderOpError: elsewhere a duplicate has its own, better answer.
function asRefusal(e) {
  if (e?.code === '23505') {
    return new FolderOpError('FOLDER_EXISTS', 409, 'Something with that name is already shared there.');
  }
  if (e?.code === '23514') {
    return new FolderOpError('SHARE_PATH_INVALID', 409,
      "That name can't be used for a folder that is shared. Please choose a shorter, simpler one.");
  }
  return e;
}

// Notification preferences follow the folder, including into another library -- the
// person asked to hear about that folder, and it still exists. Two statements, never
// one: the unique index is immediate, so a row already sitting at a path something is
// moving onto has to go before the rest are moved -- the moving one wins, since it is
// the folder the person asked about. library_id is nullable ("any library"), hence IS
// NOT DISTINCT FROM. A row that is ITSELF moving is never the one deleted: moving 'P/P'
// up onto 'P' makes 'P/P/P/x' land on 'P/P/x', which is moving too.
async function carryNotifyPrefs(q, { libraryId, destLibraryId, oldPath, newPath }) {
  const cut = folderPaths.cutFor(oldPath);
  await q.query(
    `DELETE FROM folder_notify_prefs t
      USING folder_notify_prefs s
      WHERE s.library_id IS NOT DISTINCT FROM $1
        AND (s.folder_path = $4 OR starts_with(s.folder_path, $4 || '/'))
        AND t.library_id IS NOT DISTINCT FROM $5
        AND lower(t.subscriber_email) = lower(s.subscriber_email)
        AND t.folder_path = $2 || substring(s.folder_path from $3::int)
        AND t.id <> s.id
        AND NOT (t.library_id IS NOT DISTINCT FROM $1
                 AND (t.folder_path = $4 OR starts_with(t.folder_path, $4 || '/')))`,
    [libraryId, newPath, cut, oldPath, destLibraryId]
  );
  const moved = await q.query(
    `UPDATE folder_notify_prefs s
        SET folder_path = $2 || substring(s.folder_path from $3::int), library_id = $5
      WHERE s.library_id IS NOT DISTINCT FROM $1
        AND (s.folder_path = $4 OR starts_with(s.folder_path, $4 || '/'))
      RETURNING s.id`,
    [libraryId, newPath, cut, oldPath, destLibraryId]
  );
  return moved.length;
}

// Everything that is keyed by the folder's path and is NOT a document: the shares, the
// notification preferences, and any chunked upload still arriving.
//
// `kind`: 'rename' also carries in-flight uploads, because the folder stays where it is
// and the bytes still belong there. A reparent does not -- the upload was authorised
// against the old place, and /complete tells it the folder moved instead.
async function carryPathState(q, { libraryId, destLibraryId = libraryId, oldPath, newPath, kind }) {
  try {
    return await carryPathStateWrites(q, { libraryId, destLibraryId, oldPath, newPath, kind });
  } catch (e) { throw asRefusal(e); }
}

async function carryPathStateWrites(q, { libraryId, destLibraryId, oldPath, newPath, kind }) {
  const cut = folderPaths.cutFor(oldPath);

  // The shares at and below. Shares above are left alone. created_at is not touched:
  // it is what the trash guard compares a deletion against.
  const shares = await q.query(
    `UPDATE library_grants g
        SET folder_path = $2 || substring(g.folder_path from $3::int), updated_at = NOW()
      WHERE g.library_id = $1 AND g.folder_path <> ''
        AND (g.folder_path = $4 OR starts_with(g.folder_path, $4 || '/'))
      RETURNING g.id, g.folder_path, g.subject_type, g.subject_email, g.group_id, g.permission`,
    [libraryId, newPath, cut, oldPath]
  );

  const prefs = await carryNotifyPrefs(q, { libraryId, destLibraryId, oldPath, newPath });

  // A chunked upload still arriving into a renamed folder: its name is the full path it
  // will land at, so it is re-prefixed like everything else.
  const uploads = kind === 'rename' ? await q.query(
    `UPDATE upload_sessions s
        SET name = $2 || substring(s.name from $3::int), updated_at = NOW()
      WHERE s.library_id = $1 AND s.status = 'active' AND starts_with(s.name, $4 || '/')
      RETURNING s.id`,
    [libraryId, newPath, cut, oldPath]
  ) : [];

  return { shares, prefs, uploads: uploads.length };
}

// Ending the shares a folder carried, recorded so they can be put back. The rows move
// from library_grants into library_grants_ended in one statement: a share that is gone
// from one and missing from the other would be a share nobody could restore and nobody
// could see had existed.
//
// Why the shares end at all, rather than waiting in place while the files sit in the
// Trash: a share is keyed by a path, and a path with nothing under it is a trap -- the
// next folder to take that name would be shared with whoever the old share named. The
// access rule has no notion of "deleted", so Read-Write holders would also keep write on
// trashed content at a name that no longer exists.
async function endShares(q, { libraryId, path, opId, user, cause }) {
  if (!path) return [];
  return q.query(
    `WITH gone AS (
       DELETE FROM library_grants g
        WHERE g.library_id = $1 AND g.folder_path <> ''
          AND (g.folder_path = $2 OR starts_with(g.folder_path, $2 || '/'))
       RETURNING g.*)
     INSERT INTO library_grants_ended
       (op_id, grant_id, library_id, folder_path, subject_type, subject_email, group_id,
        permission, granted_at, cause, ended_by, ended_by_email)
     SELECT $3, gone.id, gone.library_id, gone.folder_path, gone.subject_type, gone.subject_email,
            gone.group_id, gone.permission, gone.created_at, $4, $5, $6
       FROM gone
     RETURNING folder_path, subject_type, subject_email, group_id, permission`,
    [libraryId, path, opId, cause, user?.id || null, String(user?.email || '').toLowerCase() || null]
  );
}

// Which documents an operation moved to the Trash. Taken from the operation itself, never
// from whoever asks to undo it: a list from the client would let one operation's id be
// paired with an unrelated set of files. A purged document drops out on its own
// (folder_op_documents.document_id CASCADEs), which is exactly what the undo needs to
// know when it asks whether anything actually came back.
async function recordOpDocuments(q, opId, ids) {
  if (!opId || !ids.length) return 0;
  const rows = await q.query(
    `INSERT INTO folder_op_documents (op_id, document_id)
     SELECT $1, x FROM unnest($2::uuid[]) AS x ON CONFLICT DO NOTHING RETURNING document_id`,
    [opId, ids]
  );
  return rows.length;
}

// The record of a structural operation. Written inside the transaction, so an operation
// that rolled back leaves no trace of itself. Nothing reads it yet: the Trash's Undo,
// which needs an operation to point at, is the next part of this piece.
async function recordOp(q, { libraryId, targetLibraryId = null, kind, path, newPath = null, user, expiresAt = null }) {
  const row = await q.queryOne(
    `INSERT INTO folder_ops (library_id, target_library_id, kind, path, new_path, actor, actor_email, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING op_id`,
    [libraryId, targetLibraryId, kind, path, newPath, user?.id || null,
     String(user?.email || '').toLowerCase() || null, expiresAt]
  );
  return row?.op_id || null;
}

module.exports = { maxRows, grantsUnder, countUnder, refuseIfTooBig, planSharePaths, assertTotal, carryPathState, carryNotifyPrefs, endShares, recordOpDocuments, recordOp };
