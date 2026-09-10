'use strict';
// Schema — libraries, library_members, documents.library_id — plus the default
// "Ptech Workspace" seed and the backfill of pre-library documents all come from
// migrations/0004_runtime_ensure_tables.sql, applied before the server listens.
const db = require('./db');
const { isUuid } = require('./groups');
const { matchEmail } = require('./documentAccess');

// Open-by-default access: admins see all; a library with no members is open to
// everyone; otherwise only listed members (+admins) can access it.
function accessCondition(roleIdx, emailIdx, alias = 'l') {
  return `(
    $${roleIdx} = 'admin'
    OR NOT EXISTS (SELECT 1 FROM library_members m WHERE m.library_id = ${alias}.id)
    OR EXISTS (SELECT 1 FROM library_members m WHERE m.library_id = ${alias}.id AND lower(m.subject_email) = lower($${emailIdx}))
  )`;
}

// What right, if any, the caller has to ADD or CHANGE files at `parentPath` ('' for the
// library root) in a library -- decided before anything is stored or rewritten.
//
//   admin   a global admin, anywhere
//   owner   the library's owner, while a contributor
//   grant   a contributor holding a Read-Write share on the library, or on a folder at
//           or above `parentPath` (directly or through a group, matched on the verified
//           address only)
//   legacy  a contributor writing into a library nobody has shared, which is either
//           open (no members) or lists them as a member -- today's rule, kept until
//           private-by-default (piece 5) retires it
//
// `scoped` says whether what lands there becomes LIBRARY CONTENT (documents.
// library_scoped): shared with the library, managed by its owner, and no longer the
// uploader's alone. Writes under the legacy rule stay personal, exactly as today, so
// nothing written before sharing exists is exposed when sharing arrives.
// A right at a folder covers every folder below it.
//
// Returns { right, scoped } or { status, error } (400 malformed id, 404 unknown
// library, 403 no right). Viewers never have a right.
async function writeRight(user, libraryId, parentPath = '') {
  if (!isUuid(libraryId)) return { status: 400, error: 'Bad library id' };
  const row = await db.queryOne(
    `SELECT l.id, l.owner_id, COALESCE(l.owner_id = $2, false) AS is_owner,
            EXISTS (SELECT 1 FROM library_grants x WHERE x.library_id = l.id) AS shared,
            EXISTS (SELECT 1 FROM library_grants g
                     WHERE g.library_id = l.id AND g.permission = 'write'
                       AND (g.folder_path = '' OR g.folder_path = $3 OR starts_with($3, g.folder_path || '/'))
                       AND ((g.subject_type = 'user' AND g.subject_email = (SELECT ur.verified_email FROM user_roles ur WHERE ur.user_id = $2))
                         OR (g.subject_type = 'group' AND g.group_id IN (
                              SELECT gm.group_id FROM group_members gm
                               WHERE lower(gm.member_email) = (SELECT ur.verified_email FROM user_roles ur WHERE ur.user_id = $2))))) AS rw_grant,
            (NOT EXISTS (SELECT 1 FROM library_members m WHERE m.library_id = l.id)
             OR EXISTS (SELECT 1 FROM library_members m WHERE m.library_id = l.id AND $4 <> '' AND lower(m.subject_email) = lower($4))) AS legacy_listed
       FROM libraries l WHERE l.id = $1`,
    [libraryId, user?.id || null, String(parentPath || ''), matchEmail(user)]
  );
  if (!row) return { status: 404, error: 'Library not found' };
  if (user?.role === 'admin') return { right: 'admin', scoped: !!row.owner_id || !!row.shared };
  if (user?.role !== 'contributor') return { status: 403, error: "You can't add files here." };
  if (row.is_owner) return { right: 'owner', scoped: true };
  if (row.rw_grant) return { right: 'grant', scoped: true };
  if (!row.shared && row.legacy_listed) return { right: 'legacy', scoped: false };
  return { status: 403, error: "You can't add files here. Ask the library owner for Read-Write access." };
}

// Is a share attached at `path` or anywhere below it? Folder shares are keyed by path,
// and until renames and moves carry them (piece 4), a shared folder must not be
// renamed, moved or deleted out from under its share -- which would orphan the share,
// or re-attach it to whatever next took that name.
async function sharedFolderAt(libraryId, path) {
  if (!isUuid(libraryId) || !path) return false;
  const row = await db.queryOne(
    `SELECT 1 FROM library_grants
      WHERE library_id = $1 AND folder_path <> '' AND (folder_path = $2 OR starts_with(folder_path, $2 || '/'))
      LIMIT 1`,
    [libraryId, path]
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

// The creator owns the library (by user id, as with groups). Ownership is what lets
// someone share it once sharing arrives; recording it from the day the column exists
// means no library made from now on has to be adopted later.
async function createLibrary({ name, user }) {
  const email = String(user?.email || '').toLowerCase() || null;
  return db.queryOne(
    `INSERT INTO libraries (name, created_by, created_by_email, owner_id, owner_email)
     VALUES ($1, $2, $3, $2, $3) RETURNING id, name, created_by_email, owner_id, owner_email, created_at`,
    [name, user?.id || null, email]
  );
}

// Resolve the library a request targets (header / query / body), default if absent.
// A value that is present but not a uuid is refused (400) rather than passed on to
// Postgres, where the cast would fail as a 500.
async function resolveLibraryId(req) {
  const id = req.headers['x-library-id'] || req.query?.libraryId || req.body?.libraryId || null;
  if (id && !isUuid(id)) { const e = new Error('Bad library id'); e.status = 400; throw e; }
  return id || (await defaultLibraryId());
}

// Owner + name for a library id (null id → no row). Used by upload notifications.
async function info(libraryId) {
  if (!libraryId) return null;
  try { return await db.queryOne('SELECT id, name, created_by_email FROM libraries WHERE id = $1', [libraryId]); }
  catch { return null; }
}

module.exports = { defaultLibraryId, listLibraries, createLibrary, resolveLibraryId, writeRight, sharedFolderAt, listMembers, addMember, removeMember, info };
