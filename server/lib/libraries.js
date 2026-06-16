'use strict';
const db = require('./db');

let ensured = false;
const DEFAULT_LIBRARY_NAME = 'Ptech Workspace';

// Idempotent runtime migration — mirrors documentAccess.ensureDocumentAclTable so a
// deploy creates the libraries table, adds documents.library_id, seeds a default
// library, and backfills existing documents into it. Safe to call on every request.
async function ensureLibraries() {
  if (ensured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS libraries (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      name             TEXT        NOT NULL,
      created_by       UUID,
      created_by_email TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS library_id UUID');
  let def = await db.queryOne('SELECT id FROM libraries ORDER BY created_at ASC LIMIT 1');
  if (!def) {
    def = await db.queryOne('INSERT INTO libraries (name) VALUES ($1) RETURNING id', [DEFAULT_LIBRARY_NAME]);
  }
  await db.query('UPDATE documents SET library_id = $1 WHERE library_id IS NULL', [def?.id ?? null]);
  await db.query('CREATE INDEX IF NOT EXISTS documents_library_idx ON documents(library_id)');
  ensured = true;
}

async function defaultLibraryId() {
  await ensureLibraries();
  const row = await db.queryOne('SELECT id FROM libraries ORDER BY created_at ASC LIMIT 1');
  return row ? row.id : null;
}

async function listLibraries() {
  await ensureLibraries();
  return db.query('SELECT id, name, created_by_email, created_at FROM libraries ORDER BY created_at ASC');
}

async function createLibrary({ name, user }) {
  await ensureLibraries();
  return db.queryOne(
    `INSERT INTO libraries (name, created_by, created_by_email)
     VALUES ($1, $2, $3) RETURNING id, name, created_by_email, created_at`,
    [name, user?.id || null, user?.email || null]
  );
}

// Resolve the library a request targets (header / query / body), default if absent.
async function resolveLibraryId(req) {
  const id = req.headers['x-library-id'] || req.query?.libraryId || req.body?.libraryId || null;
  return id || (await defaultLibraryId());
}

module.exports = { ensureLibraries, defaultLibraryId, listLibraries, createLibrary, resolveLibraryId };
