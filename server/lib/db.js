'use strict';
const { Pool } = require('pg');

let _pool;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
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

module.exports = { query, queryOne, withTransaction };
