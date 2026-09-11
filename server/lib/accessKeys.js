'use strict';
// "Who has access, and why" (piece 3). Everything here only reads. Every level it
// reports is documentAccess.condition() itself -- evaluated for the caller here, and
// for every account in the key lists -- so a list can never disagree with who can
// actually get in; the reasons are read from the very rows the rule reads.
const db = require('./db');
const documentAccess = require('./documentAccess');
const groups = require('./groups');
const linkAccess = require('./linkAccess');

const RANK = { read: 1, write: 2, admin: 3 };
const maxLevel = (a, b) => ((RANK[a] || 0) >= (RANK[b] || 0) ? a : b) || null;
// What someone can actually use: writing needs the admin or contributor role (every
// write route is requireRole('admin','contributor'); Collabora caps edits the same way).
const effectiveFor = (role, level) => {
  if (!level) return null;
  return role === 'admin' || role === 'contributor' ? level : 'read';
};

// Each response reads one consistent snapshot, so a concurrent change can't make the
// lists contradict themselves. (hooks: tests interleave a change between statements.)
const hooks = { beforeStatement: null };
async function withSnapshot(fn) {
  return db.withTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // The rule's many small subqueries make the planner's estimates big enough to trigger
    // JIT compilation, which costs far more (a second, on a large library) than it saves
    // on statements that each touch a few thousand rows at most.
    await client.query('SET LOCAL jit = off');
    const query = async (sql, params) => {
      if (hooks.beforeStatement) await hooks.beforeStatement(sql, params);
      return (await client.query(sql, params)).rows;
    };
    return fn({ query, queryOne: async (sql, params) => (await query(sql, params))[0] ?? null });
  });
}

// The caller's level at a door, as condition() decides it: the three permission sets
// are upward closed, so the first that passes is the level. Uses $1..$5 (the caller's
// userParams at 'read') plus $6 / $7 (the write and admin sets).
function callerLevel(alias) {
  return levelWith(alias, documentAccess.refsAt(1), '$6', '$7');
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


// ======================================================================
// Who has access, and why: the key list of a library, a folder or a file
// ======================================================================
//
// A "door" is a library, a folder in one, or a file. From one snapshot this says:
//   people  every account that can get in -- its level is condition() itself, evaluated
//           here for every account at once -- with the reasons, which are the very rows
//           the rule matched, read with the fragments the rule is built from; and, for
//           a library or folder, who holds keys to only part of what's inside;
//   keys    every share, grant and link that opens the door or something inside it:
//           who each lets in, who is still waiting, and what removing it would do;
//   you     the caller's own level and reasons, for anyone who can see the door.
// If the reasons and the rule ever disagree (an edit to one and not the other), the
// person is still shown at the rule's level, the gap is named ('unexplained'), removing
// one of their keys is 'unknown', and it is logged -- never a 500 that blinds the owner.
const B = documentAccess.branches;
const KEY_FILES_SHOWN = 20;

// A statement's parameters, numbered as it is written: p(value) appends and returns $n.
function paramList() {
  const vals = [];
  const p = (v) => { vals.push(v); return `$${vals.length}`; };
  p.vals = vals;
  return p;
}

// The rule's level for principal refs R on document alias `a`, highest set first.
function levelWith(a, R, pw, pa) {
  return `CASE WHEN ${documentAccess.conditionWith(a, { ...R, perms: pa })} THEN 'admin'
            WHEN ${documentAccess.conditionWith(a, { ...R, perms: pw })} THEN 'write'
            WHEN ${documentAccess.conditionWith(a, R)} THEN 'read' END`;
}
const levelParams = (p) => ['read', 'write', 'admin'].map(l => p(documentAccess.permissionsFor(l)));

// The door as the one-row document `d` the rule is read on: the file itself, or for a
// library or folder the probe (see probe() above).
function doorRow(door, p) {
  if (door.kind === 'file') {
    return `SELECT x.id, x.uploaded_by, x.library_scoped, x.library_id, x.name
              FROM documents x WHERE x.id = ${p(door.documentId)}::uuid AND x.deleted_at IS NULL`;
  }
  return `SELECT NULL::uuid AS id, NULL::uuid AS uploaded_by, true AS library_scoped,
                 ${p(door.libraryId)}::uuid AS library_id, ${p(door.path ? `${door.path}/` : '')}::text AS name`;
}

// Whose access is being read: every stored account (as acctRefs sees each one), or
// just the caller, exactly as condition() sees this request (userParams).
const everyone = { from: 'user_roles u', uid: 'u.user_id', R: (perms) => documentAccess.acctRefs('u', perms) };
// A parameter is added only when a statement uses it (Postgres refuses unused ones).
function justMe(user, p) {
  const [role, uid, idText, email] = documentAccess.userParams(user, 'read');
  const vals = { role, uid, idText, email };
  const made = {};
  const ref = (k) => (made[k] ||= p(vals[k]));
  const R = (perms) => ({
    get role() { return ref('role'); }, get uid() { return ref('uid'); },
    get idText() { return ref('idText'); }, get email() { return ref('email'); }, perms,
  });
  return { from: '(SELECT 1) me', get uid() { return ref('uid'); }, R };
}

// Each account's level at the door: user_id -> 'admin' | 'write' | 'read'.
async function gates(q, door, who = null) {
  const p = paramList();
  const src = doorRow(door, p);
  const [pr, pw, pa] = levelParams(p);
  const principal = who ? who(p) : everyone;
  const rows = await q.query(
    `WITH d AS (${src})
     SELECT x.user_id, x.gate FROM (
       SELECT (${principal.uid})::uuid AS user_id, ${levelWith('d', principal.R(pr), pw, pa)} AS gate
         FROM d CROSS JOIN ${principal.from}) x
      WHERE x.gate IS NOT NULL`,
    p.vals
  );
  return new Map(rows.map(r => [String(r.user_id), r.gate]));
}

// Why: one row per way in that the rule matched at the door, from the rule's own parts.
async function reasonRows(q, door, who = null) {
  const p = paramList();
  const src = doorRow(door, p);
  const w = who ? who(p) : everyone;
  const R = w.R('NULL'); // no reason reads a permission set
  const cols = (o) => `(${w.uid})::uuid AS user_id, '${o.kind}'::text AS kind, (${o.level})::text AS level,
      ${o.src || 'NULL'}::uuid AS src, ${o.permission || 'NULL'}::text AS permission, ${o.group || 'NULL'}::uuid AS group_id,
      ${o.folder || 'NULL'}::text AS folder_path, ${o.by || 'NULL'}::uuid AS granted_by,
      ${o.byEmail || 'NULL'}::text AS granted_by_email, ${o.at || 'NULL'}::timestamptz AS granted_at`;
  const share = (t, kind) => cols({
    kind, level: documentAccess.shareLevel(R, `${t}.permission`), src: `${t}.id`, permission: `${t}.permission`,
    group: `${t}.group_id`, folder: `${t}.folder_path`, by: `${t}.granted_by`, byEmail: `${t}.granted_by_email`, at: `${t}.created_at`,
  });
  return q.query(
    `WITH d AS (${src})
     SELECT ${cols({ kind: 'admin', level: `'admin'` })} FROM ${w.from} WHERE ${B.admin(R)}
     UNION ALL
     SELECT ${cols({ kind: 'uploader', level: `'admin'` })} FROM d CROSS JOIN ${w.from} WHERE ${B.uploader('d', R)}
     UNION ALL
     SELECT ${cols({ kind: 'file_grant', level: 'da.permission', src: 'da.id', permission: 'da.permission', by: 'da.granted_by', byEmail: 'da.granted_by_email', at: 'da.created_at' })}
       FROM d CROSS JOIN ${w.from} JOIN document_acl da ON ${B.fileGrantRow('d', R)} AND ${B.fileGrantCounts('d')}
     UNION ALL
     SELECT ${cols({ kind: 'owner', level: documentAccess.ownerLevel(R) })}
       FROM d CROSS JOIN ${w.from} JOIN libraries pv_lo ON pv_lo.id = d.library_id AND ${B.ownerRow(R)}
      WHERE d.library_scoped
     UNION ALL
     SELECT ${share('pv_lg', 'library_share')}
       FROM d CROSS JOIN ${w.from} JOIN library_grants pv_lg
         ON pv_lg.library_id = d.library_id AND ${B.libraryShareRow()} AND ${documentAccess.shareSubject('pv_lg', R)}
      WHERE d.library_scoped
     UNION ALL
     SELECT ${share('pv_lf', 'folder_share')}
       FROM d CROSS JOIN ${w.from} JOIN library_grants pv_lf ON ${B.folderShareRow('d')} AND ${documentAccess.shareSubject('pv_lf', R)}
      WHERE d.library_scoped`,
    p.vals
  );
}

// Folder shares strictly inside a library or folder door, expanded to the accounts
// they reach, at the rule's share level. The rule's own subject match (shareSubject)
// decides every pair; for everyone at once, a plain join first finds the candidate
// pairs (a share's own address, or its group's members, against verified addresses),
// so the match runs on real pairs rather than on every share times every account.
async function insideShareRows(q, door, who = null) {
  const p = paramList();
  const lib = p(door.libraryId);
  const path = p(door.path || '');
  const scope = `g.library_id = ${lib}::uuid AND g.folder_path <> ''
        AND (${path}::text = '' OR starts_with(g.folder_path, ${path}::text || '/'))`;
  const cols = (R, uid) => `(${uid})::uuid AS user_id, g.id AS src, g.permission, g.group_id, g.folder_path, g.granted_by, g.granted_by_email,
            g.created_at AS granted_at, ${documentAccess.shareLevel(R, 'g.permission')} AS level`;
  if (who) {
    const w = who(p);
    const R = w.R('NULL');
    return q.query(`SELECT ${cols(R, w.uid)} FROM library_grants g CROSS JOIN ${w.from}
      WHERE ${scope} AND ${documentAccess.shareSubject('g', R)}`, p.vals);
  }
  const R = everyone.R('NULL');
  return q.query(
    `WITH pairs AS (
       SELECT g.id AS share_id, u.user_id FROM library_grants g
         JOIN user_roles u ON g.subject_type = 'user' AND u.verified_email = g.subject_email
        WHERE ${scope}
       UNION
       SELECT g.id, u.user_id FROM library_grants g
         JOIN group_members m ON g.subject_type = 'group' AND m.group_id = g.group_id
         JOIN user_roles u ON u.verified_email = lower(m.member_email)
        WHERE ${scope})
     SELECT ${cols(R, 'u.user_id')}
       FROM pairs JOIN library_grants g ON g.id = pairs.share_id JOIN user_roles u ON u.user_id = pairs.user_id
      WHERE ${documentAccess.shareSubject('g', R)}`,
    p.vals
  );
}

// Files inside a library or folder door given to someone one by one -- on files the
// viewer administers (condition() at 'admin' for this request), so nobody learns of
// grants on files that aren't theirs to manage. The uploader's own owner row is left
// out: on library content the rule ignores it, on a personal file the uploader reason
// already says it. Materialized, so the rule runs on grant rows, not on every file.
async function insideGrantRows(q, door, viewer) {
  const p = paramList();
  const lib = p(door.libraryId);
  const path = p(door.path || '');
  const me = justMe(viewer, p);
  const pa = p(documentAccess.permissionsFor('admin'));
  const rows = await q.query(
    `WITH s AS MATERIALIZED (
       SELECT x.id, x.name, x.library_id, x.library_scoped, x.uploaded_by,
              acl.id AS grant_id, lower(acl.subject_id) AS subject, acl.subject_email, acl.permission,
              acl.granted_by, acl.granted_by_email, acl.created_at
         FROM documents x JOIN document_acl acl ON acl.document_id = x.id AND acl.subject_type = 'user'
        WHERE x.library_id = ${lib}::uuid AND x.deleted_at IS NULL AND x.name <> '.keep' AND x.name NOT LIKE '%/.keep'
          AND (${path}::text = '' OR starts_with(x.name, ${path}::text || '/'))
          AND lower(acl.subject_id) IS DISTINCT FROM x.uploaded_by::text)
     SELECT s.* FROM s WHERE ${documentAccess.conditionWith('s', me.R(pa))}
      ORDER BY s.created_at DESC`,
    p.vals
  );
  // Who each subject is -- once per subject, not once per file: the accounts it matches
  // (as the rule matches a grant: account id, or verified address) and its account status.
  const subjects = [...new Set(rows.map(r => r.subject))];
  const who = subjects.length ? await q.query(
    `SELECT t.subject, u.user_id, ${ACCOUNT_OF_GRANT('t.subject')} AS account
       FROM unnest($1::text[]) AS t(subject)
       LEFT JOIN user_roles u ON t.subject IN (u.user_id::text, lower(coalesce(u.verified_email, '')))`,
    [subjects]
  ) : [];
  const out = [];
  for (const r of rows) for (const w of who.filter(x => x.subject === r.subject)) out.push({ ...r, user_id: w.user_id, account: w.account });
  return out;
}

// The caller's own files-given-directly count inside a door (not their own uploads).
async function myInsideGrantCount(q, door, user) {
  const p = paramList();
  const lib = p(door.libraryId);
  const path = p(door.path || '');
  const me = justMe(user, p);
  const R = me.R('NULL');
  const row = await q.queryOne(
    `SELECT count(DISTINCT x.id)::int AS n
       FROM documents x CROSS JOIN ${me.from} JOIN document_acl da ON ${B.fileGrantRow('x', R)} AND ${B.fileGrantCounts('x')}
      WHERE x.library_id = ${lib}::uuid AND x.deleted_at IS NULL AND x.name <> '.keep' AND x.name NOT LIKE '%/.keep'
        AND (${path}::text = '' OR starts_with(x.name, ${path}::text || '/'))
        AND lower(da.subject_id) IS DISTINCT FROM x.uploaded_by::text`,
    p.vals
  );
  return row ? row.n : 0;
}

// Account status of an address-keyed subject, as the rule matches it.
const ACCOUNT_OF_SHARE = (col) => `CASE WHEN EXISTS (SELECT 1 FROM user_roles r WHERE r.verified_email = ${col}) THEN 'ok'
         WHEN EXISTS (SELECT 1 FROM user_roles r WHERE lower(r.email) = ${col}) THEN 'unverified' ELSE 'none' END`;
const ACCOUNT_OF_GRANT = (col) => `CASE WHEN EXISTS (SELECT 1 FROM user_roles r WHERE lower(${col}) IN (r.user_id::text, lower(coalesce(r.verified_email, '')))) THEN 'ok'
         WHEN EXISTS (SELECT 1 FROM user_roles r WHERE lower(r.email) = lower(${col})) THEN 'unverified' ELSE 'none' END`;

// The shares that open the door, sit above it, or open something inside it.
async function shareKeyRows(q, door) {
  const p = paramList();
  const lib = p(door.libraryId);
  let where;
  if (door.kind === 'library') where = 'true';
  else if (door.kind === 'folder') {
    const path = p(door.path);
    where = `(g.folder_path = '' OR g.folder_path = ${path}::text OR starts_with(${path}::text, g.folder_path || '/')
              OR starts_with(g.folder_path, ${path}::text || '/'))`;
  } else {
    const name = p(door.name);
    where = `(g.folder_path = '' OR starts_with(${name}::text, g.folder_path || '/'))`;
  }
  return q.query(
    `SELECT g.id, g.folder_path, g.subject_type, g.subject_email, g.group_id, g.permission,
            g.granted_by, g.granted_by_email, g.created_at,
            grp.name AS group_name, grp.owner_id AS group_owner_id, grp.owner_email AS group_owner_email,
            (SELECT count(*)::int FROM group_members m WHERE m.group_id = g.group_id) AS member_count,
            CASE WHEN g.subject_type = 'user' THEN ${ACCOUNT_OF_SHARE('g.subject_email')} END AS account
       FROM library_grants g LEFT JOIN groups grp ON grp.id = g.group_id
      WHERE g.library_id = ${lib}::uuid AND ${where}
      ORDER BY g.folder_path, g.created_at`,
    p.vals
  );
}

// A file's own grants (not the uploader's owner row), with each subject's account status.
async function fileGrantKeyRows(q, documentId) {
  return q.query(
    `SELECT acl.id, acl.subject_id, acl.subject_email, acl.permission, acl.granted_by, acl.granted_by_email, acl.created_at,
            (SELECT coalesce(r.verified_email, r.email) FROM user_roles r WHERE r.user_id::text = lower(acl.subject_id)) AS account_email,
            ${ACCOUNT_OF_GRANT('acl.subject_id')} AS account
       FROM document_acl acl JOIN documents x ON x.id = acl.document_id
      WHERE acl.document_id = $1 AND acl.subject_type = 'user' AND lower(acl.subject_id) IS DISTINCT FROM x.uploaded_by::text
      ORDER BY acl.created_at`,
    [documentId]
  );
}

// Members of these groups, and whether each can get in yet (a verified account).
async function groupMemberRows(q, groupIds) {
  if (!groupIds.length) return [];
  return q.query(
    `SELECT m.group_id, lower(m.member_email) AS email,
            EXISTS (SELECT 1 FROM user_roles r WHERE r.verified_email = lower(m.member_email)) AS ok,
            EXISTS (SELECT 1 FROM user_roles r WHERE lower(r.email) = lower(m.member_email)) AS known
       FROM group_members m WHERE m.group_id = ANY($1::uuid[])
      ORDER BY lower(m.member_email)`,
    [groupIds]
  );
}

// The accounts to describe, with a display name and how many accounts share the address.
async function accountRows(q, ids) {
  if (!ids.length) return new Map();
  const rows = await q.query(
    `SELECT u.user_id, u.role, u.email, u.verified_email,
            (SELECT p.display_name FROM user_profiles p WHERE p.user_id = u.user_id AND coalesce(p.display_name, '') <> '') AS name,
            CASE WHEN u.verified_email IS NULL THEN 1
                 ELSE (SELECT count(*)::int FROM user_roles x WHERE x.verified_email = u.verified_email) END AS same_address
       FROM user_roles u WHERE u.user_id = ANY($1::uuid[])`,
    [ids]
  );
  return new Map(rows.map(r => [String(r.user_id), r]));
}

// Display names for addresses (the newest non-blank profile name for each).
async function namesFor(q, emails) {
  const list = [...new Set(emails.filter(Boolean).map(e => String(e).toLowerCase()))];
  if (!list.length) return new Map();
  const rows = await q.query(
    `SELECT DISTINCT ON (lower(p.email)) lower(p.email) AS email, p.display_name AS name
       FROM user_profiles p WHERE lower(p.email) = ANY($1::text[]) AND coalesce(p.display_name, '') <> ''
      ORDER BY lower(p.email), p.updated_at DESC`,
    [list]
  );
  return new Map(rows.map(r => [r.email, r.name]));
}

// Public links that reach into the door, on files the viewer administers, with the state
// the public routes will actually give them (lib/linkAccess, read in this snapshot).
async function linkRows(q, door, viewer) {
  const p = paramList();
  const me = justMe(viewer, p);
  const pa = p(documentAccess.permissionsFor('admin'));
  let scope;
  if (door.kind === 'file') scope = `x.id = ${p(door.documentId)}::uuid`;
  else scope = `x.library_id = ${p(door.libraryId)}::uuid AND (${p(door.path || '')}::text = '' OR starts_with(x.name, ${p(door.path || '')}::text || '/'))`;
  const files = await q.query(
    `WITH s AS MATERIALIZED (
       SELECT x.id, x.name, x.library_id, x.library_scoped, x.uploaded_by,
              l.id AS link_id, l.created_by, l.created_by_email, l.recipient_email, l.expires_at,
              (l.password_hash IS NOT NULL) AS has_password, l.allow_upload, l.access_count, l.last_accessed_at, l.created_at
         FROM document_share_links l JOIN documents x ON x.id = l.document_id
        WHERE l.revoked_at IS NULL AND x.deleted_at IS NULL AND ${scope})
     SELECT s.* FROM s WHERE ${documentAccess.conditionWith('s', me.R(pa))}
      ORDER BY s.created_at DESC`,
    p.vals
  );
  const fp = paramList();
  const fme = justMe(viewer, fp);
  const fpa = fp(documentAccess.permissionsFor('admin'));
  let fscope;
  if (door.kind === 'file') fscope = `x.id = ${fp(door.documentId)}::uuid`;
  else fscope = `x.library_id = ${fp(door.libraryId)}::uuid AND (${fp(door.path || '')}::text = '' OR starts_with(x.name, ${fp(door.path || '')}::text || '/'))`;
  const hits = await q.query(
    `WITH linked AS MATERIALIZED (
       SELECT f.id AS link_id, t.doc_id FROM folder_share_links f CROSS JOIN LATERAL unnest(f.document_ids) AS t(doc_id)
        WHERE f.revoked_at IS NULL),
     s AS MATERIALIZED (
       SELECT DISTINCT x.id, x.name, x.library_id, x.library_scoped, x.uploaded_by
         FROM documents x JOIN linked ON linked.doc_id = x.id
        WHERE x.deleted_at IS NULL AND ${fscope})
     SELECT linked.link_id, s.id AS doc_id FROM s JOIN linked ON linked.doc_id = s.id
      WHERE ${documentAccess.conditionWith('s', fme.R(fpa))}`,
    fp.vals
  );
  const ids = [...new Set(hits.map(h => String(h.link_id)))];
  const folders = ids.length ? await q.query(
    `SELECT f.id, f.folder_path, cardinality(f.document_ids) AS file_count, f.created_by, f.created_by_email, f.expires_at,
            (f.password_hash IS NOT NULL) AS has_password, f.access_count, f.last_accessed_at, f.created_at
       FROM folder_share_links f WHERE f.id = ANY($1::uuid[]) ORDER BY f.created_at DESC`,
    [ids]
  ) : [];
  const here = new Map();
  for (const h of hits) {
    const k = String(h.link_id);
    if (!here.has(k)) here.set(k, []);
    here.get(k).push(String(h.doc_id));
  }
  return { files, folders, here };
}

async function linksFor(q, door, viewer, names) {
  const { files, folders, here } = await linkRows(q, door, viewer);
  const live = (x) => !(x.expires_at && new Date(x.expires_at).getTime() < Date.now()); // as the public routes compare
  const fileLinks = files.filter(live);
  const folderLinks = folders.filter(live);
  // What each creator's links can still serve, once per creator.
  const byCreator = new Map();
  const want = (creator, ids) => {
    const k = String(creator || '');
    if (!byCreator.has(k)) byCreator.set(k, new Set());
    ids.forEach(i => byCreator.get(k).add(String(i)));
  };
  fileLinks.forEach(l => want(l.created_by, [l.id]));
  folderLinks.forEach(f => want(f.created_by, here.get(String(f.id)) || []));
  const serving = new Map();
  for (const [creator, ids] of byCreator) {
    const actor = creator ? await documentAccess.resolveActor(creator, q) : null;
    const { docs } = await linkAccess.servableDocs(creator || null, [...ids], 'd.id', q);
    const why = !actor ? 'creator_gone'
      : (actor.role !== 'admin' && actor.role !== 'contributor') ? 'creator_view_only' : 'creator_cannot_edit';
    serving.set(creator, { ids: new Set(docs.map(d => String(d.id))), why });
  }
  const person = (id, email) => ({ user_id: id || null, email: email || null, name: names.get(String(email || '').toLowerCase()) || null });
  const isAdmin = viewer.role === 'admin';
  const writer = isAdmin || viewer.role === 'contributor';
  const out = [];
  for (const l of fileLinks) {
    const s = serving.get(String(l.created_by || ''));
    const on = s.ids.has(String(l.id));
    const cut = l.name.lastIndexOf('/');
    out.push({
      ref: `lk:${l.link_id}`, kind: 'file', id: l.link_id, document_id: l.id, name: l.name.slice(cut + 1),
      folder_path: cut < 0 ? '' : l.name.slice(0, cut), file_count: 1, files_here: 1, serving: on ? 1 : 0,
      created_by: person(l.created_by, l.created_by_email), created_by_me: !!l.created_by && String(l.created_by) === String(viewer.id),
      recipient_email: l.recipient_email || null, expires_at: l.expires_at, has_password: !!l.has_password,
      allow_upload: !!l.allow_upload, access_count: Number(l.access_count) || 0, last_accessed_at: l.last_accessed_at,
      state: on ? 'active' : 'paused', paused_reason: on ? null : s.why,
      // DELETE /api/files/:id/shares/:shareId: write on the file (every file listed here is one the viewer manages)
      can_revoke: writer,
    });
  }
  for (const f of folderLinks) {
    const s = serving.get(String(f.created_by || ''));
    const ids = here.get(String(f.id)) || [];
    const n = ids.filter(i => s.ids.has(i)).length;
    out.push({
      ref: `fl:${f.id}`, kind: 'folder', id: f.id, document_id: null, name: String(f.folder_path || '').split('/').pop() || null,
      folder_path: f.folder_path, file_count: Number(f.file_count) || 0, files_here: ids.length, serving: n,
      created_by: person(f.created_by, f.created_by_email), created_by_me: !!f.created_by && String(f.created_by) === String(viewer.id),
      recipient_email: null, expires_at: f.expires_at, has_password: !!f.has_password, allow_upload: false,
      access_count: Number(f.access_count) || 0, last_accessed_at: f.last_accessed_at,
      state: n ? 'active' : 'paused', paused_reason: n ? null : s.why,
      // DELETE /api/files/folder/links/:shareId: its creator, or an admin
      can_revoke: isAdmin || (!!f.created_by && String(f.created_by) === String(viewer.id) && writer),
    });
  }
  return out;
}

// Personal files in a library or folder (admin viewers only): library shares don't reach them.
async function personalFileRows(q, door) {
  return q.query(
    `SELECT x.uploaded_by AS user_id, max(x.uploaded_by_email) AS email, count(*)::int AS count
       FROM documents x
      WHERE x.library_id = $1::uuid AND x.deleted_at IS NULL AND NOT x.library_scoped
        AND x.name <> '.keep' AND x.name NOT LIKE '%/.keep'
        AND ($2::text = '' OR starts_with(x.name, $2::text || '/'))
      GROUP BY x.uploaded_by ORDER BY max(x.uploaded_by_email)`,
    [door.libraryId, door.path || '']
  );
}

// ---- pure: reasons, reconcile, impact ----

function keyRefOf(r) {
  switch (r.kind) {
    case 'admin': return 'admins';
    case 'owner': return 'owner';
    case 'uploader': return 'uploader';
    case 'file_grant': return `fg:${r.src}`;
    case 'library_share': return `ls:${r.src}`;
    case 'folder_share': return `fs:${r.src}`;
    default: return null;
  }
}

// Where a share sits relative to the door.
function shareRelation(door, folderPath) {
  if (door.kind === 'library') return folderPath ? 'inside' : 'door';
  if (door.kind === 'file') return 'above';
  if (!folderPath) return 'above';
  if (folderPath === door.path) return 'at';
  return folderPath.length < door.path.length ? 'above' : 'inside';
}
function reasonRelation(door, r) {
  if (r.kind === 'admin' || r.kind === 'owner') return 'door';
  if (r.kind === 'uploader' || r.kind === 'file_grant') return 'at';
  return shareRelation(door, r.folder_path || '');
}

// The rule is the truth: when the reasons explain less or more than the rule's level,
// the list still shows the rule's level. Returns { reasons, drift }.
function reconcile(gate, reasons, where) {
  const best = reasons.reduce((m, r) => maxLevel(m, r.level), null);
  if ((RANK[gate] || 0) === (RANK[best] || 0)) return { reasons, drift: false };
  console.error('access-keys drift', { ...where, gate: gate || null, best: best || null }); // ids only
  if ((RANK[gate] || 0) > (RANK[best] || 0)) {
    return { reasons: [...reasons, { key: null, kind: 'unexplained', relation: 'door', level: gate }], drift: true };
  }
  const capped = reasons
    .map(r => ((RANK[r.level] || 0) > (RANK[gate] || 0) ? { ...r, level: gate || null } : r))
    .filter(r => r.level);
  return { reasons: capped, drift: true };
}

// What removing (or lowering to Read-only) one key does to the people it lets in.
// Access is an OR of independent rows, so dropping one row changes no other: a person's
// level afterwards is the best of their other reasons that open the same thing -- for a
// key on the door, their other door reasons; for a share of a folder inside, the door
// and any other share of that folder or one above it. Admins never lose access.
function impactOf(people, ref, { lowerTo = null, adminsAdmitted = 0 } = {}) {
  const lose = [], keep = [], unknown = [];
  for (const p of people) {
    const own = p.reasons.filter(r => r.key === ref);
    if (!own.length) continue;
    if (p.drift) { unknown.push(p.ref); continue; }
    const at = own[0].relation === 'inside' ? (own[0].folder_path || '') : null;
    const opensSame = at === null
      ? (r) => r.relation !== 'inside'
      : (r) => r.relation !== 'inside' || (r.kind === 'folder_share' && (r.folder_path === at || at.startsWith(`${r.folder_path}/`)));
    const before = p.reasons.filter(opensSame).reduce((m, r) => maxLevel(m, r.level), null);
    const others = p.reasons.filter(r => r.key !== ref && opensSame(r));
    const after = [...others, ...(lowerTo ? [{ level: lowerTo }] : [])].reduce((m, r) => maxLevel(m, r.level), null);
    if (!after) lose.push(p.ref);
    else keep.push({ ref: p.ref, before, after, via: [...new Set(others.filter(r => r.level === after).map(r => r.key || 'unexplained'))] });
  }
  return { lose, keep, unknown, admins_unaffected: adminsAdmitted };
}

// Files given one by one that a person keeps open anyway: a door key covers every
// library file behind it, an inside folder share the files under it; admins and a
// personal file's uploader keep theirs; and so does anyone given the same file under
// another subject (their account id as well as their address). `otherGrant(file)`
// says whether that last one holds.
function stillOpen(person, file, otherGrant = () => false) {
  if (person.is_admin_account) return true;
  if (otherGrant(file)) return true;
  if (!file.library_scoped) return !!file.uploaded_by && String(file.uploaded_by) === String(person.user_id);
  if (person.door_level) return true;
  return person.reasons.some(r => r.kind === 'folder_share' && r.relation === 'inside'
    && file.name.startsWith(`${r.folder_path}/`));
}

// ---- assembling a door ----

const personOf = (email, names) => (email ? { email, name: names.get(String(email).toLowerCase()) || null } : null);
const sortPeople = (a, b) => (Number(b.is_owner) - Number(a.is_owner)) || ((RANK[b.level] || 0) - (RANK[a.level] || 0))
  || String(a.name || a.email || '').localeCompare(String(b.name || b.email || ''));

// Everything a manager sees at a door. `hidden`: a file whose library the viewer doesn't
// manage -- the library's own sharing is the library owner's to see.
async function keyList(q, door, viewer, { hidden = false, libraryOwnerId = null } = {}) {
  const viewerIsAdmin = viewer.role === 'admin';
  const [gate, reasonsRaw] = [await gates(q, door), await reasonRows(q, door)];
  const inside = door.kind === 'file' ? { shares: [], grants: [] }
    : { shares: await insideShareRows(q, door), grants: await insideGrantRows(q, door, viewer) };
  const shareKeys = (door.kind === 'file' && (hidden || !door.libraryScoped)) ? [] : await shareKeyRows(q, door);
  const grantKeys = door.kind === 'file' ? await fileGrantKeyRows(q, door.documentId) : [];

  // Who: everyone the rule lets in, and everyone holding a key to part of what's inside.
  const ids = new Set([...gate.keys(), ...reasonsRaw.map(r => String(r.user_id)), ...inside.shares.map(r => String(r.user_id)),
    ...inside.grants.filter(g => g.user_id).map(g => String(g.user_id))]);
  const accounts = await accountRows(q, [...ids]);
  const groupIds = [...new Set(shareKeys.filter(k => k.group_id).map(k => String(k.group_id)))];
  const members = await groupMemberRows(q, groupIds);
  const names = await namesFor(q, [
    ...reasonsRaw.map(r => r.granted_by_email), ...inside.shares.map(r => r.granted_by_email), ...inside.grants.map(r => r.granted_by_email),
    ...shareKeys.map(k => k.granted_by_email), ...shareKeys.map(k => k.subject_email), ...shareKeys.map(k => k.group_owner_email),
    ...grantKeys.map(k => k.granted_by_email), ...grantKeys.map(k => k.subject_email),
  ]);
  const groupName = new Map(shareKeys.filter(k => k.group_id).map(k => [String(k.group_id), k.group_name]));
  const via = (gid) => (gid ? { id: gid, name: groupName.get(String(gid)) || null } : null);
  const reasonOut = (r, relation) => ({
    key: keyRefOf(r), kind: r.kind, relation, level: r.level, permission: r.permission || null, via_group: via(r.group_id),
    folder_path: r.folder_path ?? null, granted_by: personOf(r.granted_by_email, names), granted_at: r.granted_at || null,
  });

  const people = [];
  for (const id of ids) {
    const a = accounts.get(id);
    if (!a) continue;
    const doorReasons = reasonsRaw.filter(r => String(r.user_id) === id).map(r => reasonOut(r, reasonRelation(door, r)));
    const { reasons, drift } = reconcile(gate.get(id) || null, doorReasons, { door: door.kind, id: door.documentId || door.libraryId, user_id: id });
    const insideReasons = [
      ...inside.shares.filter(r => String(r.user_id) === id).map(r => ({ ...reasonOut({ ...r, kind: 'folder_share' }, 'inside'), level: r.level })),
    ];
    // files given one by one inside: one reason per subject the account matches
    const bySubject = new Map();
    for (const g of inside.grants.filter(x => String(x.user_id) === id)) {
      if (!bySubject.has(g.subject)) bySubject.set(g.subject, []);
      bySubject.get(g.subject).push(g);
    }
    for (const [subject, gs] of bySubject) {
      const perms = new Set(gs.map(g => g.permission));
      insideReasons.push({
        key: `fgs:${subject}`, kind: 'file_grants', relation: 'inside',
        level: gs.reduce((m, g) => maxLevel(m, g.permission), null), permission: perms.size > 1 ? 'mixed' : [...perms][0],
        via_group: null, folder_path: null, granted_by: null, granted_at: gs[0].created_at,
        files: { count: gs.length, items: gs.slice(0, KEY_FILES_SHOWN).map(g => ({ id: g.id, name: g.name, grant_id: g.grant_id, permission: g.permission })), more: Math.max(0, gs.length - KEY_FILES_SHOWN) },
      });
    }
    let all = [...reasons, ...insideReasons];
    let level = gate.get(id) || null;
    if (hidden) {
      all = all.filter(r => r.kind === 'admin' || r.kind === 'uploader' || r.kind === 'file_grant');
      if (!all.length) continue;
      level = all.reduce((m, r) => maxLevel(m, r.level), null);
    }
    if (!all.length && !level) continue;
    people.push({
      ref: `u:${id}`, user_id: a.user_id, email: a.verified_email || a.email || null, name: a.name || null,
      level, effective: effectiveFor(a.role, level), view_only: a.role !== 'admin' && a.role !== 'contributor',
      is_owner: !!libraryOwnerId && String(libraryOwnerId) === id, is_admin_account: a.role === 'admin',
      same_address_accounts: Number(a.same_address) || 1, partial: !level, ways_in: new Set(all.map(r => r.key || 'unexplained')).size,
      reasons: all, drift: drift && !hidden, door_level: level,
    });
  }

  // The keys: owner, admins, the uploader, every share and grant (waiting ones too).
  const admitted = (ref) => people.filter(p => p.reasons.some(r => r.key === ref));
  const adminsIn = (ref) => admitted(ref).filter(p => p.is_admin_account).length;
  const keys = [];
  const push = (k) => {
    const who = admitted(k.ref);
    const shown = viewerIsAdmin ? who : who.filter(p => !p.is_admin_account);
    keys.push({ ...k, admits: shown.map(p => p.ref), admits_admins: viewerIsAdmin ? 0 : who.length - shown.length });
  };
  if (!hidden && (door.kind !== 'file' || door.libraryScoped) && door.owner) {
    push({ ref: 'owner', kind: 'owner', id: null, folder_path: null, relation: 'door', subject: { type: 'user', email: door.owner.email, account: 'ok' },
      permission: null, granted_by: null, granted_at: null, waiting: null, waiting_count: 0, change_here: false, can_remove: false, impact: null, impact_if_read: null, files_impact: null });
  }
  push({ ref: 'admins', kind: 'admin', id: null, folder_path: null, relation: 'door', subject: null, permission: null, granted_by: null, granted_at: null,
    waiting: null, waiting_count: 0, change_here: false, can_remove: false, impact: null, impact_if_read: null, files_impact: null });
  if (door.kind === 'file' && !door.libraryScoped && door.uploader) {
    push({ ref: 'uploader', kind: 'uploader', id: null, folder_path: null, relation: 'at', subject: { type: 'user', email: door.uploader, account: 'ok' },
      permission: 'admin', granted_by: null, granted_at: null, waiting: null, waiting_count: 0, change_here: false, can_remove: false, impact: null, impact_if_read: null, files_impact: null });
  }
  for (const k of shareKeys) {
    const kind = k.folder_path ? 'folder_share' : 'library_share';
    const ref = `${kind === 'library_share' ? 'ls' : 'fs'}:${k.id}`;
    const relation = shareRelation(door, k.folder_path);
    let subject, waiting = null, waitingCount = 0;
    if (k.subject_type === 'group') {
      const ms = members.filter(m => String(m.group_id) === String(k.group_id));
      const out = ms.filter(m => !m.ok).map(m => ({ email: m.email, why: m.known ? 'unverified' : 'no_account' }));
      const group = { id: k.group_id, owner_id: k.group_owner_id };
      const viewable = await groups.canView(viewer, group);
      subject = { type: 'group', id: k.group_id, name: k.group_name, owner_email: k.group_owner_email, member_count: Number(k.member_count) || 0, viewable };
      waitingCount = out.length;
      waiting = viewable ? out : null;
    } else {
      subject = { type: 'user', email: k.subject_email, name: names.get(k.subject_email) || null, account: k.account };
      if (k.account !== 'ok') { waiting = [{ email: k.subject_email, why: k.account === 'unverified' ? 'unverified' : 'no_account' }]; waitingCount = 1; }
    }
    push({
      ref, kind, id: k.id, folder_path: k.folder_path, relation, subject, permission: k.permission,
      granted_by: personOf(k.granted_by_email, names), granted_at: k.created_at, waiting, waiting_count: waitingCount,
      change_here: relation === 'door' || relation === 'at', can_remove: true,
    });
  }
  for (const k of grantKeys) {
    const address = String(k.subject_id || '').includes('@');
    const email = address ? String(k.subject_id).toLowerCase() : (k.account_email || null);
    push({
      ref: `fg:${k.id}`, kind: 'file_grant', id: k.id, folder_path: null, relation: 'at',
      subject: { type: 'user', email, name: names.get(String(email || '').toLowerCase()) || null, account: k.account },
      permission: k.permission, granted_by: personOf(k.granted_by_email, names), granted_at: k.created_at,
      waiting: k.account === 'ok' ? null : [{ email, why: k.account === 'unverified' ? 'unverified' : 'no_account' }],
      waiting_count: k.account === 'ok' ? 0 : 1, change_here: true, can_remove: true,
    });
  }
  // files given one by one inside a library or folder, one key per subject
  const subjects = new Map();
  for (const g of inside.grants) {
    if (!subjects.has(g.subject)) subjects.set(g.subject, []);
    subjects.get(g.subject).push(g);
  }
  for (const [subject, gs] of subjects) {
    const files = [...new Map(gs.map(g => [String(g.id), g])).values()];
    const perms = new Set(files.map(g => g.permission));
    const account = gs[0].account;
    const address = subject.includes('@');
    push({
      ref: `fgs:${subject}`, kind: 'file_grants', id: null, folder_path: door.path || '', relation: 'inside',
      subject: { type: 'user', email: address ? subject : null, name: names.get(subject) || null, account },
      permission: perms.size > 1 ? 'mixed' : [...perms][0], granted_by: null, granted_at: files[0]?.created_at || null,
      waiting: account === 'ok' ? null : [{ email: address ? subject : null, why: account === 'unverified' ? 'unverified' : 'no_account' }],
      waiting_count: account === 'ok' ? 0 : 1,
      change_here: false,
      // DELETE /api/files/folder/members: in a folder, by address, never your own
      can_remove: !!door.path && address && subject !== String(viewer.email || '').toLowerCase(),
      files: { count: files.length, items: files.slice(0, KEY_FILES_SHOWN).map(g => ({ id: g.id, name: g.name, grant_id: g.grant_id, permission: g.permission })), more: Math.max(0, files.length - KEY_FILES_SHOWN) },
      _files: files,
    });
  }

  // What removing each key would do.
  for (const k of keys) {
    if (k.kind === 'file_grants') {
      // revoking every file given to them here: how many stay open anyway, for all it admits
      const who = admitted(k.ref);
      const subject = k.ref.slice(4);
      const other = (p) => (f) => inside.grants.some(g => String(g.user_id) === String(p.user_id) && String(g.id) === String(f.id) && g.subject !== subject);
      k.files_impact = { files: k._files.length, still_open: who.length ? Math.min(...who.map(p => k._files.filter(f => stillOpen(p, f, other(p))).length)) : 0 };
      k.impact = null;
      k.impact_if_read = null;
    } else if (k.can_remove) {
      const impact = impactOf(people, k.ref, { adminsAdmitted: adminsIn(k.ref) });
      k.impact = hidden && door.libraryScoped ? hiddenImpact(impact) : impact;
      k.impact_if_read = (k.kind === 'library_share' || k.kind === 'folder_share') && k.permission === 'write'
        ? impactOf(people, k.ref, { lowerTo: 'read', adminsAdmitted: adminsIn(k.ref) }) : null;
      k.files_impact = null;
    }
    delete k._files;
  }
  if (!viewerIsAdmin) for (const k of keys) if (k.impact) scrubAdmins(k, people);

  const shownPeople = (viewerIsAdmin ? people : people.filter(p => !p.is_admin_account)).sort(sortPeople).map(p => {
    const { drift, door_level, is_admin_account, ...rest } = p;
    return viewerIsAdmin ? { ...rest, is_admin: is_admin_account } : rest;
  });
  const adminPeople = people.filter(p => p.is_admin_account);
  const admins = viewerIsAdmin
    ? { count: adminPeople.length, named: adminPeople.map(p => ({ user_id: p.user_id, email: p.email, name: p.name })) }
    : { count: adminPeople.length };
  return { people: shownPeople, keys, admins, names };
}

// A file whose library the viewer doesn't manage: someone losing their last visible key
// may still get in through the library's sharing, which the viewer isn't shown.
function hiddenImpact(impact) {
  return { ...impact, lose: [], unknown: [...impact.unknown, ...impact.lose] };
}
// Non-admin viewers never see admin accounts by name.
function scrubAdmins(k, people) {
  const adminRefs = new Set(people.filter(p => p.is_admin_account).map(p => p.ref));
  const strip = (i) => i && { ...i, lose: i.lose.filter(r => !adminRefs.has(r)), keep: i.keep.filter(x => !adminRefs.has(x.ref)), unknown: i.unknown.filter(r => !adminRefs.has(r)) };
  k.impact = strip(k.impact);
  k.impact_if_read = strip(k.impact_if_read);
}

// The caller's own access at the door, as this request's condition() decides it.
async function yourAccess(q, door, user, { listed = null } = {}) {
  const level = (await gates(q, door, (p) => justMe(user, p))).get(String(user.id)) || null;
  const rows = await reasonRows(q, door, (p) => justMe(user, p));
  const names = await namesFor(q, rows.map(r => r.granted_by_email));
  const groupIds = [...new Set(rows.filter(r => r.group_id).map(r => String(r.group_id)))];
  const groupNames = groupIds.length ? new Map((await q.query('SELECT id, name FROM groups WHERE id = ANY($1::uuid[])', [groupIds])).map(g => [String(g.id), g.name])) : new Map();
  const doorReasons = rows.map(r => ({
    key: keyRefOf(r), kind: r.kind, relation: reasonRelation(door, r), level: r.level, permission: r.permission || null,
    via_group: r.group_id ? { id: r.group_id, name: groupNames.get(String(r.group_id)) || null } : null,
    folder_path: r.folder_path ?? null, granted_by: personOf(r.granted_by_email, names), granted_at: r.granted_at || null,
  }));
  const { reasons } = reconcile(level, doorReasons, { door: door.kind, id: door.documentId || door.libraryId, user_id: String(user.id), you: true });
  const out = { level, effective: effectiveFor(user.role, level), view_only: user.role !== 'admin' && user.role !== 'contributor', reasons };
  if (door.kind !== 'file') {
    const folders = (await insideShareRows(q, door, (p) => justMe(user, p)))
      .reduce((m, r) => m.set(r.folder_path, maxLevel(m.get(r.folder_path), r.level)), new Map());
    out.inside = { folders: [...folders].map(([path, lvl]) => ({ path, level: lvl })), files: await myInsideGrantCount(q, door, user) };
    out.listed_because = null;
    if (!level && listed && !out.inside.folders.length && !out.inside.files) {
      if (listed.no_members && !listed.shared) out.listed_because = 'open';
      else if (listed.member_listed) out.listed_because = 'member_list';
      else if (listed.can_read_any) out.listed_because = 'your_files';
    }
  }
  out.owner = door.owner ? { email: door.owner.email, name: door.owner.name || null } : null;
  return out;
}

// GET /api/access/libraries/:id[?folder=] -- the route has already checked the caller
// may see the library (and, for a manager, that the folder exists).
async function libraryDoor(user, { library, listed, path = '', manager }) {
  return withSnapshot(async (q) => {
    const ownerName = library.owner_email ? (await namesFor(q, [library.owner_email])).get(String(library.owner_email).toLowerCase()) : null;
    const owner = library.owner_email ? { user_id: library.owner_id || null, email: library.owner_email, name: ownerName || null } : null;
    const door = { kind: path ? 'folder' : 'library', libraryId: library.id, path, owner, libraryScoped: true };
    const out = {
      door: { kind: door.kind, library: { id: library.id, name: library.name, owner }, path, name: path ? path.split('/').pop() : library.name },
      can_see_keys: !!manager, generated_at: new Date().toISOString(),
      you: await yourAccess(q, door, user, { listed }),
    };
    if (!manager) return out;
    const list = await keyList(q, door, user, { libraryOwnerId: library.owner_id });
    out.people = list.people;
    out.keys = list.keys;
    out.links = await linksFor(q, door, user, list.names);
    out.admins = list.admins;
    if (user.role === 'admin') out.personal_files = (await personalFileRows(q, door)).map(r => ({ ...r, name: list.names.get(String(r.email || '').toLowerCase()) || null }));
    return out;
  });
}

// GET /api/access/files/:id -- the route has already checked the caller can read it.
async function fileDoor(user, { doc, library, full, detail }) {
  return withSnapshot(async (q) => {
    const cut = doc.name.lastIndexOf('/');
    const names = await namesFor(q, [library?.owner_email, doc.uploaded_by_email]);
    const owner = library?.owner_email ? { user_id: library.owner_id || null, email: library.owner_email, name: names.get(String(library.owner_email).toLowerCase()) || null } : null;
    const door = {
      kind: 'file', documentId: doc.id, libraryId: doc.library_id, name: doc.name, libraryScoped: !!doc.library_scoped,
      owner: doc.library_scoped ? owner : null, uploader: doc.uploaded_by_email || null,
    };
    const out = {
      door: {
        kind: 'file',
        file: {
          id: doc.id, name: doc.name.slice(cut + 1), folder: cut < 0 ? '' : doc.name.slice(0, cut),
          library: library ? { id: library.id, name: library.name, owner_email: library.owner_email } : null,
          library_content: !!doc.library_scoped,
          added_by: { email: doc.uploaded_by_email || null, name: names.get(String(doc.uploaded_by_email || '').toLowerCase()) || null, can_get_in: null },
        },
      },
      can_see_keys: !!full, generated_at: new Date().toISOString(),
      you: await yourAccess(q, door, user),
    };
    if (!full) return out;
    const hidden = detail === 'hidden';
    const list = await keyList(q, door, user, { hidden, libraryOwnerId: doc.library_scoped ? library?.owner_id : null });
    if (!hidden && doc.uploaded_by) out.door.file.added_by.can_get_in = (await gates(q, door)).has(String(doc.uploaded_by));
    out.library_detail = hidden ? 'hidden' : 'full';
    out.hidden_note = hidden ? { library_owner_email: library?.owner_email || null } : null;
    out.people = list.people;
    out.keys = list.keys;
    out.links = await linksFor(q, door, user, list.names);
    out.admins = list.admins;
    return out;
  });
}

module.exports = {
  sharedWithMe, libraryDoor, fileDoor, withSnapshot, callerLevel, callerParams, probe, effectiveFor, maxLevel, RANK,
  reconcile, impactOf, stillOpen, shareRelation, levelWith, hooks,
};

