'use strict';
// Shares of a library, or of a folder in it, with a person (by address) or a group, at
// Read-Write or Read-only (table: migrations/0007_library_sharing.sql). What a share
// gives is decided in one place, documentAccess.condition(); this module only stores
// and lists them. The owner of the library (or an admin) manages them -- the routes
// in routes/libraries.js check that before calling in here.
const db = require('./db');
const documentAccess = require('./documentAccess');

// Every share of a library, with what a manager needs to judge it: the group's name,
// owner and size; whether a person's address belongs to an account, and a verified
// one (a share only ever matches a verified address); and whether a shared folder still
// has anything in it.
const SHARE_COLUMNS = `
  g.id, g.library_id, g.folder_path, g.subject_type, g.subject_email, g.group_id, g.permission,
  g.granted_by_email, g.created_at, g.updated_at,
  grp.name AS group_name, grp.owner_email AS group_owner_email,
  (SELECT count(*) FROM group_members gm WHERE gm.group_id = g.group_id)::int AS group_member_count,
  CASE WHEN g.subject_type <> 'user' THEN NULL
       WHEN EXISTS (SELECT 1 FROM user_roles ur WHERE ur.verified_email = g.subject_email) THEN 'ok'
       WHEN EXISTS (SELECT 1 FROM user_roles ur WHERE lower(ur.email) = g.subject_email) THEN 'unverified'
       ELSE 'none' END AS account,
  (g.folder_path = '' OR EXISTS (SELECT 1 FROM documents d
     WHERE d.library_id = g.library_id AND d.deleted_at IS NULL AND starts_with(d.name, g.folder_path || '/'))) AS folder_present`;

function shape(r) {
  if (!r) return null;
  return {
    id: r.id, library_id: r.library_id, folder_path: r.folder_path, subject_type: r.subject_type,
    subject_email: r.subject_email,
    group: r.subject_type === 'group' ? { id: r.group_id, name: r.group_name, owner_email: r.group_owner_email, member_count: r.group_member_count } : null,
    permission: r.permission, granted_by_email: r.granted_by_email, created_at: r.created_at, updated_at: r.updated_at,
    account: r.account, folder_present: r.folder_present,
  };
}

async function listShares(libraryId) {
  const rows = await db.query(
    `SELECT ${SHARE_COLUMNS} FROM library_grants g LEFT JOIN groups grp ON grp.id = g.group_id
      WHERE g.library_id = $1
      ORDER BY g.folder_path, g.subject_type DESC, lower(coalesce(grp.name, g.subject_email))`,
    [libraryId]
  );
  return rows.map(shape);
}

async function getShare(libraryId, shareId, q = db) {
  return shape(await q.queryOne(
    `SELECT ${SHARE_COLUMNS} FROM library_grants g LEFT JOIN groups grp ON grp.id = g.group_id
      WHERE g.library_id = $1 AND g.id = $2`,
    [libraryId, shareId]
  ));
}

// The same subject already holding a share at this path (for the 409 on a duplicate).
async function findShare(libraryId, folderPath, { email, groupId }, q = db) {
  const row = await q.queryOne(
    `SELECT g.id FROM library_grants g
      WHERE g.library_id = $1 AND g.folder_path = $2
        AND ((g.subject_type = 'user' AND g.subject_email = $3) OR (g.subject_type = 'group' AND g.group_id = $4))`,
    [libraryId, folderPath, email || null, groupId || null]
  );
  return row ? getShare(libraryId, row.id, q) : null;
}

// Throws Postgres' own errors: 23505 for a duplicate, 23503 when the library or group
// was deleted meanwhile -- the route turns those into 409 and 404.
async function createShare({ libraryId, folderPath, email, groupId, permission, user }, q = db) {
  const row = await q.queryOne(
    `INSERT INTO library_grants (library_id, folder_path, subject_type, subject_email, group_id, permission, granted_by, granted_by_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [libraryId, folderPath, email ? 'user' : 'group', email || null, email ? null : groupId, permission,
     user?.id || null, String(user?.email || '').toLowerCase() || null]
  );
  return getShare(libraryId, row.id, q); // the same client: the row is not committed yet
}

// Conditional on the level the caller saw when they were authorised, so two managers
// changing one share at once can't silently overwrite each other (null when it changed
// or went away meanwhile).
async function setPermission(libraryId, shareId, from, to) {
  const row = await db.queryOne(
    `UPDATE library_grants SET permission = $4, updated_at = NOW()
      WHERE id = $2 AND library_id = $1 AND permission = $3 RETURNING id`,
    [libraryId, shareId, from, to]
  );
  return row ? getShare(libraryId, row.id) : null;
}

async function deleteShare(libraryId, shareId) {
  return db.queryOne('DELETE FROM library_grants WHERE id = $2 AND library_id = $1 RETURNING *', [libraryId, shareId]);
}

// Does the folder exist, among files the CALLER can read? Sharing a folder must not
// reveal whether someone else's private folder of that name exists.
// `q`: readable inside a caller's transaction.
async function folderVisibleTo(libraryId, folderPath, user, q = db) {
  const row = await q.queryOne(
    `SELECT 1 FROM documents d
      WHERE d.library_id = $1 AND d.deleted_at IS NULL AND starts_with(d.name, $2 || '/')
        AND ${documentAccess.condition('d', 3)}
      LIMIT 1`,
    [libraryId, folderPath, ...documentAccess.userParams(user, 'read')]
  );
  return !!row;
}

async function countForGroup(groupId) {
  const row = await db.queryOne('SELECT count(*)::int AS n FROM library_grants WHERE group_id = $1', [groupId]);
  return row ? row.n : 0;
}

module.exports = { listShares, getShare, findShare, createShare, setPermission, deleteShare, folderVisibleTo, countForGroup };
