'use strict';
// Putting a deleted folder back.
//
// Deleting a folder to the Trash ends whatever it was shared with, so undoing it has to
// put two things back: the files, and the sharing. Both come from the operation's own
// record (folder_ops, folder_op_documents, library_grants_ended) -- never from whoever is
// asking, because a list of ids from a client could be paired with somebody else's
// operation, and because a promise of "you have a day to change your mind" means nothing
// if it lives in a page that can be reloaded.
//
// Everything here runs inside the folder operation's transaction, holding the library's
// tree lock (lib/folderOps.js).
const db = require('./db');
const documentAccess = require('./documentAccess');
const { prefixRange } = require('./documents');
const { FolderOpError } = require('./folderOps');

// How long an undo stays available. The toast is seconds; this is the window in which the
// folder's Share panel can still offer to share it again.
const windowMinutes = () => Number(process.env.FOLDER_UNDO_WINDOW_MIN || 1440);

const opRow = (q, opId) => q.queryOne(
  `SELECT op_id, library_id, kind, path, actor_email, created_at, expires_at, undone_at
     FROM folder_ops WHERE op_id = $1`, [opId]);

// The operation to undo, or the reason it cannot be. Read twice: once to learn which
// library to lock, then again on the locked client, because between the two reads
// somebody else may have undone it.
async function loadOp(q, opId, { forUndo = true } = {}) {
  const op = await opRow(q, opId);
  if (!op || op.kind !== 'delete') throw new FolderOpError(null, 404, 'That deletion could not be found.');
  if (forUndo && op.expires_at && new Date(op.expires_at) < new Date()) {
    throw new FolderOpError('UNDO_EXPIRED', 409,
      "It's too late to undo this one. The files are still in the Trash, and the folder's Share panel can tell you who it was shared with.",
      { path: op.path, expired_at: op.expires_at });
  }
  return op;
}

// Has anything ELSE taken the folder's place while it sat in the Trash? Putting the files
// back into a folder somebody has since made, or shared, would merge the two -- and this
// is the one path that would also resurrect the old sharing on top of it.
async function refuseIfSomethingTookThePlace(q, op) {
  const clash = await q.queryOne(
    `SELECT
       EXISTS (SELECT 1 FROM documents d
                WHERE d.library_id = $1 AND ${prefixRange('d', '$2')} AND d.deleted_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM folder_op_documents od
                                   WHERE od.op_id = $3 AND od.document_id = d.id)) AS has_live,
       EXISTS (SELECT 1 FROM library_grants g
                WHERE g.library_id = $1 AND g.folder_path <> ''
                  AND (g.folder_path = $2 OR starts_with(g.folder_path, $2 || '/'))) AS has_shares`,
    [op.library_id, op.path, op.op_id]
  );
  if (clash?.has_live || clash?.has_shares) {
    throw new FolderOpError('FOLDER_EXISTS', 409,
      `Something else is using “${String(op.path).split('/').pop()}” now, so this can't be put back as it was. Restore the files you need from the Trash instead.`,
      { path: op.path });
  }
}

// The files. Only the ones this operation trashed, only while they are still trashed, and
// only those the person undoing may change.
async function restoreDocuments(q, op, user) {
  const p = db.paramList();
  const id = p(op.op_id);
  const rule = documentAccess.conditionInTrash('d', p.vals.length + 1);
  p.vals.push(...documentAccess.userParams(user, 'write'));
  const by = p(user?.id || null);
  const byEmail = p(String(user?.email || '').toLowerCase() || null);
  return q.query(
    `UPDATE documents d
        SET deleted_at = NULL, deleted_by = NULL, deleted_by_email = NULL,
            restored_at = NOW(), restored_by = ${by}::uuid, restored_by_email = ${byEmail}
      WHERE d.id IN (SELECT od.document_id FROM folder_op_documents od WHERE od.op_id = ${id})
        AND d.deleted_at IS NOT NULL AND ${rule}
      RETURNING d.id, d.name`,
    p.vals
  );
}

/* The sharing.
 *
 * A share only comes back if something it covered actually came back live underneath it:
 * re-creating a share over an empty name is the dormant share this whole piece exists to
 * prevent. A share to a group that has since been deleted is skipped before the insert,
 * not caught after it -- library_grants.group_id has a foreign key, so letting it fail
 * would abort the undo for everyone else on the list.
 *
 * Which rows came back is taken from RETURNING, never assumed: with ON CONFLICT DO
 * NOTHING a conflicting row is silently not inserted, and stamping the lot as restored
 * would record shares that are not there.
 */
async function restoreShares(q, op, user) {
  const back = await q.query(
    `WITH back AS (
       INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email,
                                   group_id, permission, granted_by, granted_by_email)
       SELECT e.library_id, e.folder_path, e.subject_type, e.subject_email, e.group_id,
              e.permission, $2, $3
         FROM library_grants_ended e
        WHERE e.op_id = $1 AND e.restored_at IS NULL
          AND (e.group_id IS NULL OR EXISTS (SELECT 1 FROM groups gr WHERE gr.id = e.group_id))
          AND EXISTS (SELECT 1 FROM documents d
                       WHERE d.library_id = e.library_id AND d.deleted_at IS NULL
                         AND ${prefixRange('d', 'e.folder_path')})
       ON CONFLICT DO NOTHING
       RETURNING id, library_id, folder_path, subject_type, subject_email, group_id, permission)
     UPDATE library_grants_ended e SET restored_at = NOW(), restored_op = $1
       FROM back b
      WHERE e.op_id = $1 AND e.library_id = b.library_id AND e.folder_path = b.folder_path
        AND e.subject_email IS NOT DISTINCT FROM b.subject_email
        AND e.group_id IS NOT DISTINCT FROM b.group_id
      RETURNING e.folder_path, e.subject_type, e.subject_email, e.group_id, e.permission`,
    [op.op_id, user?.id || null, String(user?.email || '').toLowerCase() || null]
  );
  // Whatever is still unrestored, with the reason -- so the answer can say what did not
  // come back rather than quietly leaving people out.
  const missed = await q.query(
    `SELECT e.folder_path, e.subject_type, e.subject_email, e.group_id, e.permission,
            CASE WHEN e.group_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM groups gr WHERE gr.id = e.group_id)
                   THEN 'group_gone'
                 WHEN NOT EXISTS (SELECT 1 FROM documents d
                                   WHERE d.library_id = e.library_id AND d.deleted_at IS NULL
                                     AND ${prefixRange('d', 'e.folder_path')})
                   THEN 'nothing_came_back'
                 ELSE 'already_shared' END AS reason
       FROM library_grants_ended e
      WHERE e.op_id = $1 AND e.restored_at IS NULL`,
    [op.op_id]
  );
  return { restored: back, missed };
}

// The whole undo, on the locked client. Answering the same way twice is deliberate: a
// second undo of the same operation is not an error, it just has nothing left to do.
async function undo(q, { opId, user }) {
  const op = await loadOp(q, opId);
  if (op.undone_at) return { op, already: true, documents: [], shares: [], missed: [] };
  await refuseIfSomethingTookThePlace(q, op);
  const documents = await restoreDocuments(q, op, user);
  const { restored, missed } = await restoreShares(q, op, user);
  await q.query('UPDATE folder_ops SET undone_at = NOW() WHERE op_id = $1', [op.op_id]);
  return { op, already: false, documents, shares: restored, missed };
}

// What a folder's Share panel offers after the toast has gone: the shares that ended with
// a deletion here and have not been put back, inside the window.
async function endedSharesAt(q, libraryId, folderPath) {
  return q.query(
    `SELECT e.folder_path, e.subject_type, e.subject_email, e.group_id, e.permission,
            e.ended_at, e.cause, o.op_id, o.expires_at,
            (SELECT gr.name FROM groups gr WHERE gr.id = e.group_id) AS group_name
       FROM library_grants_ended e
       JOIN folder_ops o ON o.op_id = e.op_id
      WHERE e.library_id = $1 AND e.restored_at IS NULL
        AND (e.folder_path = $2 OR starts_with(e.folder_path, $2 || '/'))
        AND o.undone_at IS NULL AND (o.expires_at IS NULL OR o.expires_at > NOW())
        AND (e.group_id IS NULL OR EXISTS (SELECT 1 FROM groups gr WHERE gr.id = e.group_id))
      ORDER BY e.ended_at DESC, e.folder_path, e.subject_email`,
    [libraryId, folderPath]
  );
}

module.exports = { windowMinutes, loadOp, opRow, undo, endedSharesAt, restoreDocuments, restoreShares };
