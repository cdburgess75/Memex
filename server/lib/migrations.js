'use strict';
// Forward-only schema migrations.
//
// Numbered .sql files in server/migrations/ are applied in filename order, each
// exactly once, inside a transaction, and recorded in a schema_migrations table.
// This gives released versions a deterministic, ordered, recorded way to evolve the
// schema — the gap that made upgrades risky (schema changes were scattered idempotent
// CREATE/ALTER IF NOT EXISTS calls with no ordering, no record, and no rollback).
//
// The app still carries those historical idempotent calls; NEW schema changes should
// be added here as a numbered .sql file instead.
const fs = require('fs');
const path = require('path');
const db = require('./db');

const DIR = path.join(__dirname, '..', 'migrations');

async function ensureTable() {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

// Numbered .sql files, in deterministic (lexical) order. Names must start with a
// digit and end in .sql (e.g. 0001_add_widgets.sql); anything else (README, notes)
// is ignored, so zero-padded prefixes keep ordering stable past 9.
function migrationFiles(dir = DIR) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => /^\d.*\.sql$/i.test(n)).sort();
}

async function appliedSet() {
  const rows = await db.query('SELECT name FROM schema_migrations');
  return new Set(rows.map(r => r.name));
}

// Apply every not-yet-applied migration in order. Each file runs in its own
// transaction together with its bookkeeping insert, so a failure rolls that file
// back and stops the run (later files are left unapplied, and the error propagates).
async function run({ dir = DIR, log = () => {} } = {}) {
  await ensureTable();
  const applied = await appliedSet();
  const pending = migrationFiles(dir).filter(n => !applied.has(n));
  const ran = [];
  for (const name of pending) {
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    await db.withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
    ran.push(name);
    log(`[migrations] applied ${name}`);
  }
  return { applied: ran, alreadyApplied: applied.size };
}

module.exports = { run, migrationFiles, ensureTable, DIR };
