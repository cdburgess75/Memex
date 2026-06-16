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
  await db.query(`
    CREATE TABLE IF NOT EXISTS library_members (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      library_id        UUID        NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      subject_email     TEXT        NOT NULL,
      added_by          UUID,
      added_by_email    TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(library_id, subject_email)
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS library_members_library_idx ON library_members(library_id)');
  ensured = true;
}

// Open-by-default access: admins see all; a library with no members is open to
// everyone; otherwise only listed members (+admins) can access it.
function accessCondition(roleIdx, emailIdx, alias = 'l') {
  return `(
    $${roleIdx} = 'admin'
    OR NOT EXISTS (SELECT 1 FROM library_members m WHERE m.library_id = ${alias}.id)
    OR EXISTS (SELECT 1 FROM library_members m WHERE m.library_id = ${alias}.id AND lower(m.subject_email) = lower($${emailIdx}))
  )`;
}

async function canAccessLibrary(user, libraryId) {
  await ensureLibraries();
  if (!libraryId) return true;
  const row = await db.queryOne(
    `SELECT 1 FROM libraries l WHERE l.id = $3 AND ${accessCondition(1, 2, 'l')}`,
    [user?.role || '', user?.email || '', libraryId]
  );
  return !!row;
}

async function listMembers(libraryId) {
  await ensureLibraries();
  return db.query(
    'SELECT id, subject_email, added_by_email, created_at FROM library_members WHERE library_id = $1 ORDER BY created_at ASC',
    [libraryId]
  );
}

async function addMember(libraryId, { email, user }) {
  await ensureLibraries();
  return db.queryOne(
    `INSERT INTO library_members (library_id, subject_email, added_by, added_by_email)
     VALUES ($1, lower($2), $3, $4)
     ON CONFLICT (library_id, subject_email) DO UPDATE SET subject_email = EXCLUDED.subject_email
     RETURNING id, subject_email, added_by_email, created_at`,
    [libraryId, email, user?.id || null, user?.email || null]
  );
}

async function removeMember(libraryId, memberId) {
  await ensureLibraries();
  return db.queryOne('DELETE FROM library_members WHERE id = $1 AND library_id = $2 RETURNING id', [memberId, libraryId]);
}

async function defaultLibraryId() {
  await ensureLibraries();
  const row = await db.queryOne('SELECT id FROM libraries ORDER BY created_at ASC LIMIT 1');
  return row ? row.id : null;
}

async function listLibraries(user) {
  await ensureLibraries();
  return db.query(
    `SELECT l.id, l.name, l.created_by_email, l.created_at
     FROM libraries l
     WHERE ${accessCondition(1, 2, 'l')}
     ORDER BY l.created_at ASC`,
    [user?.role || '', user?.email || '']
  );
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

module.exports = { ensureLibraries, defaultLibraryId, listLibraries, createLibrary, resolveLibraryId, canAccessLibrary, listMembers, addMember, removeMember };
