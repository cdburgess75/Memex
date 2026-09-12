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
  return db.withTransaction(async (client) => {
    await folderLocks.session(client, kind);
    await folderLocks.tree(client, libraryIds, mode);
    return fn(clientQ(client), client);
  });
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

module.exports = { withFolderOp, clientQ, FolderOpError, sendFolderOpError, hooks };
