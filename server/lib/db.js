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

module.exports = { query, queryOne };
