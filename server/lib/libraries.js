'use strict';
// Schema — libraries, library_members, documents.library_id — plus the default
// "Ptech Workspace" seed and the backfill of pre-library documents all come from
// migrations/0004_runtime_ensure_tables.sql, applied before the server listens.
const db = require('./db');

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
  if (!libraryId) return true;
  const row = await db.queryOne(
    `SELECT 1 FROM libraries l WHERE l.id = $3 AND ${accessCondition(1, 2, 'l')}`,
    [user?.role || '', user?.email || '', libraryId]
  );
  return !!row;
}

async function listMembers(libraryId) {
  return db.query(
    'SELECT id, subject_email, added_by_email, created_at FROM library_members WHERE library_id = $1 ORDER BY created_at ASC',
    [libraryId]
  );
}

async function addMember(libraryId, { email, user }) {
  return db.queryOne(
    `INSERT INTO library_members (library_id, subject_email, added_by, added_by_email)
     VALUES ($1, lower($2), $3, $4)
     ON CONFLICT (library_id, subject_email) DO UPDATE SET subject_email = EXCLUDED.subject_email
     RETURNING id, subject_email, added_by_email, created_at`,
    [libraryId, email, user?.id || null, user?.email || null]
  );
}

async function removeMember(libraryId, memberId) {
  return db.queryOne('DELETE FROM library_members WHERE id = $1 AND library_id = $2 RETURNING id', [memberId, libraryId]);
}

async function defaultLibraryId() {
  const row = await db.queryOne('SELECT id FROM libraries ORDER BY created_at ASC LIMIT 1');
  return row ? row.id : null;
}

async function listLibraries(user) {
  return db.query(
    `SELECT l.id, l.name, l.created_by_email, l.created_at
     FROM libraries l
     WHERE ${accessCondition(1, 2, 'l')}
     ORDER BY l.created_at ASC`,
    [user?.role || '', user?.email || '']
  );
}

async function createLibrary({ name, user }) {
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

// Owner + name for a library id (null id → no row). Used by upload notifications.
async function info(libraryId) {
  if (!libraryId) return null;
  try { return await db.queryOne('SELECT id, name, created_by_email FROM libraries WHERE id = $1', [libraryId]); }
  catch { return null; }
}

module.exports = { defaultLibraryId, listLibraries, createLibrary, resolveLibraryId, canAccessLibrary, listMembers, addMember, removeMember, info };
