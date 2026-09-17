'use strict';
// Every structural folder operation -- rename, move, delete -- rewrites a library's
// paths, so two of them must not interleave, and nothing may place a document by name
// while one runs. Each one therefore happens inside ONE transaction that takes the
// library's tree lock as its first statements, and re-runs its checks on that client:
// what was true before the lock was taken is only a fast refusal, never the decision.
//
// (Piece 4. The operations themselves still do exactly what they did; what this adds is
// that they are atomic and serialized.)
const db = require('./db');
const folderLocks = require('./folderLocks');
const documentAccess = require('./documentAccess');
const libraries = require('./libraries');
const { prefixRange } = require('./documents');

// Tests interleave a change between statements, as accessKeys.hooks does.
const hooks = { beforeStatement: null };

// A pg client wearing lib/db's clothes: query() gives rows, queryOne() the first.
function clientQ(client) {
  const query = async (sql, params = []) => {
    if (hooks.beforeStatement) await hooks.beforeStatement(sql, params);
    return (await client.query(sql, params)).rows;
  };
  return { query, queryOne: async (sql, params) => (await query(sql, params))[0] ?? null, client };
}

// Run fn inside the transaction, holding `mode` on every library involved.
// `kind` picks how long to wait: a folder operation gives up sooner than an upload,
// which is holding the person's bytes.
async function withFolderOp({ libraryIds, kind = 'folder', mode = 'exclusive' }, fn) {
  // No library, no lock: folderLocks.tree has nothing to take and says nothing. A caller
  // that got here without one would run "under the lock" holding none, so that is an
  // error here rather than a silence there.
  if (!(libraryIds || []).some(Boolean)) throw new Error('withFolderOp: no library to lock');
  return db.withTransaction(async (client) => {
    await folderLocks.session(client, kind);
    await folderLocks.tree(client, libraryIds, mode);
    return fn(clientQ(client), client);
  });
}

// A placement that changes ONE existing document: its name, or whether it is in the Trash.
// The lock is keyed by the library the caller read before asking for it, and that is only
// a guess -- a transfer can have carried the row to another library while we waited, and
// we would then be writing a name into a tree whose lock we do not hold. So the row is
// read again on the operation's client and the library checked against the one locked;
// fn gets the row as it is NOW. A row from before libraries has no library_id; it
// surfaces in the default library, and that is the tree it is locked in.
async function withDocumentPlacement(doc, fn) {
  const lib = String(doc.library_id || (await libraries.defaultLibraryId()));
  return withFolderOp({ libraryIds: [lib], kind: 'placement', mode: 'shared' }, async (q, client) => {
    const now = await q.queryOne('SELECT name, library_id, deleted_at FROM documents WHERE id = $1', [doc.id]);
    if (!now) throw new FolderOpError(null, 404, 'Document not found');
    if (String(now.library_id || lib) !== lib) {
      throw new FolderOpError('FILE_MOVED', 409, 'That file has just moved to another library. Refresh and try again.');
    }
    return fn(q, now, lib, client);
  });
}

// Is there already something at the destination? A folder is only a name prefix, so
// "already there" means: live documents under it, documents under it in the Trash (their
// names are held for the whole retention window), or a share attached to it. The subtree
// being moved is excluded, so moving 'P/P' up to 'P' is not a clash with itself.
//
// Live documents are counted only if they are library content or the caller can read
// them: a stranger's personal folder of the same name neither blocks the move nor is
// revealed by it, and no share can reach it, so sharing cannot change by merging with it.
async function whatIsAt(q, { destLibraryId, newPath, fromLibraryId = null, fromPath = null, viewer }) {
  const p = db.paramList();
  const dst = p(destLibraryId);
  const np = p(newPath);
  const src = p(fromLibraryId);
  const sp = p(fromPath || '');
  const readable = documentAccess.condition('d', p.vals.length + 1);
  p.vals.push(...documentAccess.userParams(viewer, 'read'));
  const moving = `NOT (${src}::uuid IS NOT NULL AND d.library_id = ${src}::uuid AND ${sp}::text <> ''
                       AND (d.name = ${sp} OR starts_with(d.name, ${sp} || '/')))`;
  const movingShare = `NOT (${src}::uuid IS NOT NULL AND g.library_id = ${src}::uuid AND ${sp}::text <> ''
                            AND (g.folder_path = ${sp} OR starts_with(g.folder_path, ${sp} || '/')))`;
  return q.queryOne(
    `SELECT
       EXISTS (SELECT 1 FROM documents d
                WHERE d.library_id = ${dst}::uuid AND ${prefixRange('d', np)} AND d.deleted_at IS NULL
                  AND (d.library_scoped OR ${readable}) AND ${moving}) AS has_live,
       (SELECT max(d.deleted_at) FROM documents d
         WHERE d.library_id = ${dst}::uuid AND starts_with(d.name, ${np} || '/')
           AND d.deleted_at IS NOT NULL AND d.library_scoped AND ${moving}) AS trashed_at,
       EXISTS (SELECT 1 FROM library_grants g
                WHERE g.library_id = ${dst}::uuid AND g.folder_path <> ''
                  AND (g.folder_path = ${np} OR starts_with(g.folder_path, ${np} || '/'))
                  AND ${movingShare}) AS has_shares`,
    p.vals
  );
}

// An operation's own refusal: the route sends it as it is.
class FolderOpError extends Error {
  constructor(code, status, message, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

// The right to add files at `path`, proved on the operation's own client -- or the
// refusal, thrown as the route will send it.
async function writeRightOrThrow(user, libraryId, path, q) {
  const r = await libraries.writeRight(user, libraryId, path, q);
  if (r.status) throw new FolderOpError(null, r.status, r.error);
  return r;
}

// Turn what came back into a response: our own refusals, Postgres' "I won't wait any
// longer", and the constraints that back the checks up. Anything else is a 500.
function sendFolderOpError(res, e) {
  if (e instanceof FolderOpError) {
    res.status(e.status).json({ ...(e.code ? { code: e.code } : {}), error: e.message, ...e.extra });
    return true;
  }
  const busy = folderLocks.busyError(e);
  if (busy) return res.status(busy.status).json(busy.body) && true;
  return false;
}

module.exports = { withFolderOp, withDocumentPlacement, clientQ, whatIsAt, FolderOpError, writeRightOrThrow, sendFolderOpError, hooks };
