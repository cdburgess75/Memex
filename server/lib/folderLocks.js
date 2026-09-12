'use strict';
// Folder operations rewrite a library's paths (documents.name, library_grants.folder_path
// and the rest), so two of them in the same library must not interleave, and nothing may
// place a document by name while one is running. Postgres advisory locks, held for the
// transaction, give us that without a table: one lock per library, taken as the first
// statements of the transaction.
//
// Kept at READ COMMITTED on purpose. A writer must NOT use REPEATABLE READ: its snapshot
// is taken by the statement that blocks, so after waiting it would miss the previous
// holder's commit and fail with 40001. (accessKeys.withSnapshot is REPEATABLE READ READ
// ONLY -- that is for readers.)
const TREE_NS = 0x4470; // 17520; the two-int form shows objsubid 2, so it can never
                        // collide with auditLog's one-int AUDIT_LOCK.

// Take the tree lock on every library involved, in ascending KEY order -- the key is what
// orders the wait graph, so two operations touching the same pair of libraries in
// opposite directions cannot deadlock.
async function tree(client, libraryIds, mode = 'exclusive') {
  const fn = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  const ids = [...new Set((libraryIds || []).filter(Boolean).map(String))];
  if (!ids.length) return;
  const { rows } = await client.query(
    'SELECT DISTINCT hashtext(id) AS k FROM unnest($1::text[]) AS id ORDER BY 1', [ids]);
  for (const r of rows) await client.query(`SELECT ${fn}($1::int, $2::int)`, [TREE_NS, r.k]);
}

// SET LOCAL takes no parameters, so these are literals. Placing a document waits longer
// than a folder operation does: it is holding the person's bytes.
const PROFILE = {
  folder: { lock: '3000ms', stmt: '120000ms' },
  placement: { lock: '10000ms', stmt: '30000ms' },
};
async function session(client, kind = 'folder') {
  const p = PROFILE[kind] || PROFILE.folder;
  await client.query(`SET LOCAL lock_timeout = '${p.lock}'`);
  await client.query(`SET LOCAL statement_timeout = '${p.stmt}'`);
  await client.query('SET LOCAL jit = off'); // the access rule's subqueries trip JIT
}

// What a caller should answer when Postgres refuses to wait any longer.
// 55P03 lock_not_available, 40P01 deadlock_detected -> busy; 57014 statement_timeout -> too big.
function busyError(e) {
  if (!e || !e.code) return null;
  if (e.code === '55P03' || e.code === '40P01') {
    return { status: 409, body: { code: 'LIBRARY_BUSY', error: 'Another change to this library is still running. Try again in a moment.', retry_after_ms: 3000 } };
  }
  if (e.code === '57014') {
    return { status: 409, body: { code: 'FOLDER_TOO_LARGE', error: 'This folder has too many files to change in one go. Move some of it first.' } };
  }
  return null;
}

module.exports = { TREE_NS, PROFILE, tree, session, busyError };
