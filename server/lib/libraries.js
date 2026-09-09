'use strict';
// Schema — libraries, library_members, documents.library_id — plus the default
// "Ptech Workspace" seed and the backfill of pre-library documents all come from
// migrations/0004_runtime_ensure_tables.sql, applied before the server listens.
const db = require('./db');

// Open-by-default access: admins see all; a library explicitly marked org_shared
// is open to everyone; a library with no members is open to everyone; otherwise
// only listed members (+admins) can access it.
//
// org_shared and the empty-member case both resolve to "everyone" today, so this
// clause looks redundant — it is not. The empty-member case makes openness an
// accident of an empty table, and removing a library's last member silently
// un-restricts it. org_shared is the deliberate version, and it is the one that
// also grants access to the documents inside (see lib/documentAccess.js).
function accessCondition(roleIdx, emailIdx, alias = 'l') {
  return `(
    $${roleIdx} = 'admin'
    OR ${alias}.org_shared
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
    `SELECT l.id, l.name, l.created_by_email, l.created_at, l.org_shared
     FROM libraries l
     WHERE ${accessCondition(1, 2, 'l')}
     ORDER BY l.created_at ASC`,
    [user?.role || '', user?.email || '']
  );
}

async function createLibrary({ name, user }) {
  return db.queryOne(
    `INSERT INTO libraries (name, created_by, created_by_email)
     VALUES ($1, $2, $3) RETURNING id, name, created_by_email, created_at, org_shared`,
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

// Marking a library org-shared changes who can reach every document inside it, so
// it is admin-only at the route and recorded in the audit chain by the caller.
//
// Closing a library has to undo what being open allowed, or the setting is a
// one-way door: while it was open every member held 'write', which is the bar for
// minting a public share link, and those links are redeemed at an unauthenticated
// route that never consults the library. So on close, revoke exactly the links
// whose creator could not mint them again now — not the owner's, not an admin's,
// not anyone holding a real write grant.
async function setOrgShared(libraryId, shared) {
  const row = await db.queryOne(
    `UPDATE libraries SET org_shared = $2 WHERE id = $1
     RETURNING id, name, created_by_email, created_at, org_shared`,
    [libraryId, !!shared]
  );
  if (!row || shared) return row ? { ...row, revoked_links: 0 } : row;
  const revoked = await db.query(
    `UPDATE document_share_links sl
        SET revoked_at = NOW()
       FROM documents d
      WHERE sl.document_id = d.id
        AND d.library_id = $1
        AND sl.revoked_at IS NULL
        AND sl.created_by IS DISTINCT FROM d.uploaded_by
        AND NOT EXISTS (
          SELECT 1 FROM user_roles ur
           WHERE ur.user_id = sl.created_by AND ur.role = 'admin'
        )
        AND NOT EXISTS (
          SELECT 1 FROM document_acl da
           WHERE da.document_id = d.id
             AND da.subject_type = 'user'
             AND lower(da.subject_id) IN (lower(sl.created_by::text), lower(coalesce(sl.created_by_email, '')))
             AND da.permission IN ('write', 'admin')
        )
      RETURNING sl.id`,
    [libraryId]
  );
  return { ...row, revoked_links: revoked.length };
}

module.exports = { defaultLibraryId, listLibraries, createLibrary, setOrgShared, resolveLibraryId, canAccessLibrary, listMembers, addMember, removeMember, info };
