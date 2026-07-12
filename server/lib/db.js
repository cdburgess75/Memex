'use strict';
const { Pool } = require('pg');

let _pool;
function getPool() {
  if (!_pool) _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX) || 20,
    // Fail fast instead of hanging forever if the pool is momentarily exhausted.
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS) || 5000,
  });
  return _pool;
}

async function query(sql, params = []) {
  const { rows } = await getPool().query(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

// Run fn inside a single-connection transaction. fn receives a client whose
// .query() participates in the transaction; COMMIT on success, ROLLBACK on throw.
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
    throw e;
  } finally {
    client.release();
  }
}

// Close the pool (integration-test teardown; the app itself never calls this).
async function end() { if (_pool) { const p = _pool; _pool = null; await p.end(); } }

module.exports = { query, queryOne, withTransaction, end };
