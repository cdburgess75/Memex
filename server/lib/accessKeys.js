'use strict';
// "Who has access, and why" (piece 3). Everything here only reads. Every level it
// reports is documentAccess.condition() itself -- evaluated for the caller here, and
// for every account in the key lists -- so a list can never disagree with who can
// actually get in; the reasons are read from the very rows the rule reads.
const db = require('./db');
const documentAccess = require('./documentAccess');

const RANK = { read: 1, write: 2, admin: 3 };
const maxLevel = (a, b) => ((RANK[a] || 0) >= (RANK[b] || 0) ? a : b) || null;
// What someone can actually use: writing needs the admin or contributor role (every
// write route is requireRole('admin','contributor'); Collabora caps edits the same way).
const effectiveFor = (role, level) => {
  if (!level) return null;
  return role === 'admin' || role === 'contributor' ? level : 'read';
};

// Each response reads one consistent snapshot, so a concurrent change can't make the
// lists contradict themselves.
async function withSnapshot(fn) {
  return db.withTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return fn({ query: async (sql, params) => (await client.query(sql, params)).rows });
  });
}

// The caller's level at a door, as condition() decides it: the three permission sets
// are upward closed, so the first that passes is the level. Uses $1..$5 (the caller's
// userParams at 'read') plus $6 / $7 (the write and admin sets).
function callerLevel(alias) {
  const R = documentAccess.refsAt(1);
  const RW = { ...R, perms: '$6' };
  const RA = { ...R, perms: '$7' };
  return `CASE WHEN ${documentAccess.conditionWith(alias, RA)} THEN 'admin'
            WHEN ${documentAccess.conditionWith(alias, RW)} THEN 'write'
            WHEN ${documentAccess.conditionWith(alias, R)} THEN 'read' END`;
}
const callerParams = (user) => [
  ...documentAccess.userParams(user, 'read'),
  documentAccess.permissionsFor('write'),
  documentAccess.permissionsFor('admin'),
];

// A person's newest non-blank display name, by address.
const nameOf = (emailExpr) => `(SELECT p.display_name FROM user_profiles p
    WHERE lower(p.email) = lower(${emailExpr}) AND coalesce(p.display_name, '') <> '' ORDER BY p.updated_at DESC LIMIT 1)`;
const person = (email, name) => (email ? { email, name: name || null } : null);

// A library or folder "door" as a one-row probe document: library content with no id
// and no uploader, named '' for the library root or '<path>/' for a folder. condition()
// admits someone to it exactly when a key reaches every library file behind that door,
// including files added later: a NULL id matches no per-file grant, a NULL uploader no
// uploader, and starts_with('<path>/', F || '/') holds only for F = the folder itself or
// a folder above it.
const probe = (libraryExpr, pathExpr) => `(SELECT NULL::uuid AS id, NULL::uuid AS uploaded_by, true AS library_scoped,
    ${libraryExpr} AS library_id, CASE WHEN ${pathExpr} = '' THEN '' ELSE ${pathExpr} || '/' END AS name)`;

// Shared with me: libraries, folders and files other people have shared with the caller
// -- directly, or with a group they're in -- across every library. Their own libraries,
// their own personal files and anything they reach only by being an admin are not
// "shared with" them. Shares match only a verified address, so an account without one
// is told so and shown nothing (it must not learn what was shared with an address it
// merely claims).
async function sharedWithMe(user) {
  const out = {
    // the address the rule matches for this caller ('' = none verified)
    email_verified: documentAccess.matchEmail(user) !== '',
    is_admin: user?.role === 'admin',
    libraries: [], folders: [], files: [], truncated: { files: false },
  };
  if (!out.email_verified) return out;
  const R = documentAccess.refsAt(1);
  const params = callerParams(user);
  const viewOnly = user.role !== 'admin' && user.role !== 'contributor';
  return withSnapshot(async (q) => {
    const shares = await q.query(
      `SELECT g.id AS share_id, g.library_id, g.folder_path, g.group_id, g.permission, g.granted_by_email, g.created_at,
              l.name AS library_name, l.owner_email, ${nameOf('l.owner_email')} AS owner_name,
              grp.name AS group_name, ${nameOf('g.granted_by_email')} AS granted_by_name,
              ${callerLevel('p')} AS level,
              st.files, st.bytes, st.updated_at
         FROM library_grants g
         JOIN libraries l ON l.id = g.library_id
         LEFT JOIN groups grp ON grp.id = g.group_id
         CROSS JOIN LATERAL ${probe('l.id', 'g.folder_path')} p
         CROSS JOIN LATERAL (
           SELECT count(*)::int AS files, coalesce(sum(d.size), 0)::bigint AS bytes,
                  max(coalesce(d.restored_at, d.created_at)) AS updated_at
             FROM documents d
            WHERE d.library_id = l.id AND d.deleted_at IS NULL AND d.library_scoped
              AND d.name <> '.keep' AND d.name NOT LIKE '%/.keep'
              AND (g.folder_path = '' OR starts_with(d.name, g.folder_path || '/'))) st
        WHERE ${documentAccess.shareSubject('g', R)} AND l.owner_id IS DISTINCT FROM $2
        ORDER BY lower(l.name), g.folder_path`,
      params
    );
    const byDoor = new Map();
    for (const r of shares) {
      const key = `${r.library_id}|${r.folder_path}`;
      if (!byDoor.has(key)) {
        byDoor.set(key, {
          library: { id: r.library_id, name: r.library_name, owner: person(r.owner_email, r.owner_name) },
          path: r.folder_path, level: null, shares: [],
          files: r.files, bytes: Number(r.bytes) || 0, updated_at: r.updated_at,
        });
      }
      const door = byDoor.get(key);
      door.level = maxLevel(door.level, r.level);
      door.shares.push({
        share_id: r.share_id,
        via_group: r.group_id ? { id: r.group_id, name: r.group_name } : null,
        permission: r.permission,
        granted_by: person(r.granted_by_email, r.granted_by_name),
        granted_at: r.created_at,
      });
    }
    for (const d of byDoor.values()) {
      if (!d.level) continue; // a share the rule doesn't honour for this account (never expected)
      const row = { ...d, effective: effectiveFor(user.role, d.level), view_only: viewOnly };
      if (d.path === '') { delete row.path; out.libraries.push(row); } else out.folders.push({ ...row, name: d.path.split('/').pop() });
    }
    for (const f of out.folders) {
      const whole = out.libraries.find(l => l.library.id === f.library.id);
      f.also_whole_library = !!whole && (RANK[whole.level] || 0) >= (RANK[f.level] || 0);
    }

    // Files given to the caller's address one by one: one row per file (older data can
    // hold the same address twice in different case), showing the strongest grant.
    const files = await q.query(
      `WITH m AS MATERIALIZED (
         SELECT DISTINCT ON (d.id) d.id, d.name, d.size, d.created_at, d.library_id, d.library_scoped, d.uploaded_by, d.uploaded_by_email,
                acl.id AS grant_id, acl.permission, acl.granted_by_email, acl.created_at AS granted_at
           FROM document_acl acl JOIN documents d ON d.id = acl.document_id
          WHERE acl.subject_type = 'user' AND $4 <> '' AND lower(acl.subject_id) = lower($4) AND d.deleted_at IS NULL
            AND d.name <> '.keep' AND d.name NOT LIKE '%/.keep'
            AND NOT (NOT d.library_scoped AND d.uploaded_by IS NOT DISTINCT FROM $2)
          ORDER BY d.id, CASE acl.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 ELSE 1 END DESC, acl.created_at DESC)
       SELECT m.*, l.name AS library_name, l.owner_email AS library_owner_email,
              ${nameOf('m.granted_by_email')} AS granted_by_name,
              ${nameOf('CASE WHEN m.library_scoped THEN l.owner_email ELSE m.uploaded_by_email END')} AS owner_name,
              ${callerLevel('m')} AS level
         FROM m LEFT JOIN libraries l ON l.id = m.library_id
        WHERE ${documentAccess.condition('m', 1)}
        ORDER BY m.granted_at DESC
        LIMIT 501`,
      params
    );
    out.truncated.files = files.length > 500;
    out.files = files.slice(0, 500).map(r => {
      const cut = r.name.lastIndexOf('/');
      return {
        document: {
          id: r.id, name: r.name.slice(cut + 1), folder: cut < 0 ? '' : r.name.slice(0, cut), size: Number(r.size) || 0,
          created_at: r.created_at, library: r.library_id ? { id: r.library_id, name: r.library_name } : null,
        },
        level: r.level, effective: effectiveFor(user.role, r.level), grant_id: r.grant_id, permission: r.permission,
        granted_by: person(r.granted_by_email, r.granted_by_name), granted_at: r.granted_at,
        owner: person(r.library_scoped ? r.library_owner_email : r.uploaded_by_email, r.owner_name),
      };
    });
    return out;
  });
}

module.exports = { sharedWithMe, withSnapshot, callerLevel, callerParams, probe, effectiveFor, maxLevel, RANK };
