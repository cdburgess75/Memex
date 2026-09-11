'use strict';
// Schema — libraries, library_members, documents.library_id — plus the default
// "Ptech Workspace" seed and the backfill of pre-library documents all come from
// migrations/0004_runtime_ensure_tables.sql, applied before the server listens.
const db = require('./db');
const { isUuid } = require('./groups');
const documentAccess = require('./documentAccess');

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
    // $4 is the address as the library switcher matches members (the address the
    // account signs in with): the legacy rule is today's rule, unchanged. Shares
    // (library_grants) match only the verified address, looked up by account id.
    [libraryId, user?.id || null, String(parentPath || ''), String(user?.email || '').toLowerCase()]
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

// The caller as shares see them: their verified address, looked up by account id ($idx).
const verifiedEmailOf = (idx) => `(SELECT ur.verified_email FROM user_roles ur WHERE ur.user_id = $${idx})`;
function shareSubject(t, idIdx) {
  return `((${t}.subject_type = 'user' AND ${t}.subject_email = ${verifiedEmailOf(idIdx)})
       OR (${t}.subject_type = 'group' AND ${t}.group_id IN (
            SELECT gm.group_id FROM group_members gm WHERE lower(gm.member_email) = ${verifiedEmailOf(idIdx)})))`;
}

// Which libraries a caller sees in their list, and their relationship to each.
// Parameters: $1 role, $2 the address they sign in with (lower-cased), $3 user id, then
// the five userParams() at $4..$8 for "can open any file in it".
// A library is listed to: an admin; its owner; everyone, while it has no members and
// no shares (the old open rule -- a shared library leaves that list); a listed member
// (the old rule, matched as the switcher always has); anyone it or a folder in it is
// shared with; and anyone who can open any file in it -- their own personal files, or
// files shared with them one by one -- so sharing a library never hides it from them.
const LISTING = `
  SELECT v.* FROM (
    SELECT l.id, l.name, l.created_by_email, l.created_at, l.owner_id, l.owner_email,
           EXISTS (SELECT 1 FROM library_grants x WHERE x.library_id = l.id) AS shared,
           NOT EXISTS (SELECT 1 FROM library_members m WHERE m.library_id = l.id) AS no_members,
           EXISTS (SELECT 1 FROM library_members m WHERE m.library_id = l.id AND $2 <> '' AND lower(m.subject_email) = $2) AS member_listed,
           (SELECT max(g.permission) FROM library_grants g
             WHERE g.library_id = l.id AND g.folder_path = '' AND ${shareSubject('g', 3)}) AS root_level,
           (SELECT json_agg(json_build_object('path', f.folder_path, 'level', f.level) ORDER BY f.folder_path)
              FROM (SELECT g.folder_path, max(g.permission) AS level FROM library_grants g
                     WHERE g.library_id = l.id AND g.folder_path <> '' AND ${shareSubject('g', 3)}
                     GROUP BY g.folder_path) f) AS folders,
           EXISTS (SELECT 1 FROM documents d
                    WHERE d.library_id = l.id AND d.deleted_at IS NULL AND ${documentAccess.condition('d', 4)}) AS can_read_any,
           (SELECT json_agg(DISTINCT g.folder_path) FROM library_grants g
             WHERE g.library_id = l.id AND g.folder_path <> '') AS shared_folders
      FROM libraries l
  ) v
  WHERE ($1 = 'admin' OR v.owner_id = $3 OR (v.no_members AND NOT v.shared) OR v.member_listed
         OR v.root_level IS NOT NULL OR v.folders IS NOT NULL OR v.can_read_any)`;

// One listed row, as the caller may see it.
//   can_manage  may share it: an admin, or its owner while a contributor
//   my_access   'admin' | 'owner' | 'rw' | 'r' (a share of the whole library) |
//               'folders' (shares of folders in it only) | 'listed' (the old rules, or
//               personal files) -- viewers are capped at read
//   my_folders  [{ path, level: 'rw' | 'r' }] the folders shared with them
//   add_right   what writeRight answers at the root: 'admin' | 'owner' | 'grant' |
//               'legacy' | null (folder shares are in my_folders)
//   shared      whether it is shared at all -- only to someone who manages it
//   shared_folders  the folders in it that are shared (they can't be renamed, moved or
//               deleted until shares follow them) -- only to someone who manages it
function shapeLibrary(user, r) {
  const admin = user?.role === 'admin';
  const contributor = user?.role === 'contributor';
  const isOwner = !!r.owner_id && !!user?.id && String(r.owner_id) === String(user.id);
  const level = (p) => (p === 'write' && contributor ? 'rw' : 'r');
  const myFolders = (r.folders || []).map(f => ({ path: f.path, level: level(f.level) }));
  const canManage = admin || (contributor && isOwner);
  let myAccess = null;
  if (isOwner) myAccess = 'owner'; // an admin's own library is still theirs
  else if (admin) myAccess = 'admin';
  else if (r.root_level) myAccess = level(r.root_level);
  else if (myFolders.length) myAccess = 'folders';
  else if ((r.no_members && !r.shared) || r.member_listed || r.can_read_any) myAccess = 'listed';
  let addRight = null;
  if (admin) addRight = 'admin';
  else if (contributor) {
    if (isOwner) addRight = 'owner';
    else if (r.root_level === 'write') addRight = 'grant';
    else if (!r.shared && (r.no_members || r.member_listed)) addRight = 'legacy';
  }
  const out = {
    id: r.id, name: r.name, created_by_email: r.created_by_email, created_at: r.created_at,
    owner_id: r.owner_id, owner_email: r.owner_email,
    can_manage: canManage, my_access: myAccess, my_folders: myFolders, add_right: addRight,
  };
  if (canManage) { out.shared = !!r.shared; out.shared_folders = r.shared_folders || []; }
  return out;
}

const listingParams = (user) => [user?.role || '', String(user?.email || '').toLowerCase(), user?.id || null,
  ...documentAccess.userParams(user, 'read')];

async function listLibraries(user) {
  const rows = await db.query(`${LISTING} ORDER BY v.created_at ASC`, listingParams(user));
  return rows.map(r => shapeLibrary(user, r));
}

// The library, if the caller may see it in their list (null otherwise, or for an id
// that is not a uuid).
async function visibleLibrary(user, libraryId) {
  if (!isUuid(libraryId)) return null;
  const row = await db.queryOne(`${LISTING} AND v.id = $9`, [...listingParams(user), libraryId]);
  return row ? shapeLibrary(user, row) : null;
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

module.exports = { defaultLibraryId, listLibraries, visibleLibrary, shapeLibrary, createLibrary, resolveLibraryId, writeRight, sharedFolderAt, listMembers, addMember, removeMember, info };
