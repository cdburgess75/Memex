'use strict';
const db = require('./db');

const PERMISSION_LEVELS = {
  read: ['read', 'write', 'admin'],
  write: ['write', 'admin'],
  admin: ['admin'],
};

// document_acl schema: migrations/0004_runtime_ensure_tables.sql.

function permissionsFor(required = 'read') {
  return PERMISSION_LEVELS[required] || PERMISSION_LEVELS.read;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validPermission(permission) {
  return Object.prototype.hasOwnProperty.call(PERMISSION_LEVELS, permission);
}

// The address a per-file grant may match. Blank when the identity provider has said
// outright that the address is NOT verified, so an account that merely claims someone
// else's address can't open files shared with that address. A token that says nothing
// either way keeps today's behaviour for per-file grants; library, folder and group
// shares go further and match only a verified address (user_roles.verified_email).
function matchEmail(user) {
  return user?.emailVerified === false ? '' : String(user?.email || '').toLowerCase();
}

function userParams(user, required = 'read') {
  return [
    user?.role || '',
    user?.id || null,
    String(user?.id || ''),
    matchEmail(user),
    permissionsFor(required),
  ];
}

// THE rule for who may open or change a document. Every document query in Depot goes
// through it, with the five parameters userParams() supplies starting at $s:
//   $s role, $s+1 user id, $s+2 user id as text, $s+3 matchEmail, $s+4 permissions[]
// Only those five are referenced, so no caller's later parameter numbers move.
//
// A document is reachable by:
//   - a global admin;
//   - its uploader -- unless it is LIBRARY CONTENT (documents.library_scoped), which
//     belongs to its library: a Read-Write share lets you add files there, and when
//     the share ends so does your access to what you added;
//   - a per-file grant (document_acl) to the caller's id or address -- except the
//     uploader's own owner row on library content, for the same reason;
//   - on library content only: the library's owner (document admin while a
//     contributor, read otherwise); a share of the whole library; or a share of a
//     folder the document is in (a live prefix, matched exactly: '_' and '%' are
//     ordinary characters). Shares go to a person or a group, and match only the
//     caller's VERIFIED address (user_roles.verified_email, looked up by id), never
//     the address a token merely claims. Group membership is read live.
// A share can only ever give read or write -- write only to a contributor; viewers
// and anything unknown get read -- so no share reaches document admin (managing a
// file's own access list stays with owners and admins). A library that nobody is a
// member of is NOT open for this purpose: that old rule only ever controlled listing.
//
// The rule is written once, in named parts, over "refs": the SQL for the caller's
// role, id, id as text, address and permission set. condition(alias, s) uses the $s..
// $s+4 parameters of a request; acctRefs() uses a user_roles row, so the same rule can
// be evaluated for every account at once (who can get in, and why -- lib/accessKeys).
// The parts are also the row sources of each reason, so a reason and the rule can
// never be two different ideas of the same thing. The text condition() produces is
// pinned byte for byte by __tests__/lib/documentAccess.golden.test.js.
const refsAt = (s = 1) => ({ role: `$${s}`, uid: `$${s + 1}`, idText: `$${s + 2}`, email: `$${s + 3}`, perms: `$${s + 4}` });
// A stored account (user_roles row `t`), exactly as userParams(resolveActor(id)) sees it:
// role, id, id as text, its VERIFIED address ('' when none), and a permission set.
const acctRefs = (t, perms) => ({
  role: `coalesce(${t}.role,'')`, uid: `${t}.user_id`, idText: `${t}.user_id::text`,
  email: `coalesce(${t}.verified_email,'')`, perms,
});

// The caller's verified address, looked up by account id (never the claimed one).
const verifiedOf = (r) => `(SELECT pv_ur.verified_email FROM user_roles pv_ur WHERE pv_ur.user_id = ${r.uid})`;
// What a share of `level` gives this caller: write only to a contributor, else read.
const shareLevel = (r, level) => `(CASE WHEN ${r.role} = 'contributor' AND ${level} = 'write' THEN 'write' ELSE 'read' END)`;
// What owning the library gives: document admin while a contributor, else read.
const ownerLevel = (r) => `(CASE WHEN ${r.role} = 'contributor' THEN 'admin' ELSE 'read' END)`;
// Is share row `t` for this caller -- to their verified address, or a group they're in.
const shareSubject = (t, r) => `((${t}.subject_type = 'user' AND ${t}.subject_email = ${verifiedOf(r)})
          OR (${t}.subject_type = 'group' AND ${t}.group_id IN (
                SELECT pv_gm.group_id FROM group_members pv_gm WHERE lower(pv_gm.member_email) = ${verifiedOf(r)})))`;

// The branches, each usable on its own. `a` is the document alias; the row sources use
// fixed inner aliases: da (document_acl), pv_lo (libraries), pv_lg / pv_lf (library_grants).
const B = {
  admin: (r) => `${r.role} = 'admin'`,
  uploader: (a, r) => `(${a}.uploaded_by = ${r.uid} AND NOT ${a}.library_scoped)`,
  // document_acl row `da` on document `a` that is this caller's (any permission)
  fileGrantRow: (a, r) => `da.document_id = ${a}.id
        AND da.subject_type = 'user'
        AND lower(da.subject_id) IN (lower(${r.idText}), lower(${r.email}))`,
  // ...and that counts: not the uploader's own owner row on library content
  fileGrantCounts: (a) => `NOT (${a}.library_scoped AND lower(da.subject_id) IS NOT DISTINCT FROM ${a}.uploaded_by::text)`,
  // library `pv_lo` owned by this caller
  ownerRow: (r) => `pv_lo.owner_id = ${r.uid}`,
  // whole-library share `pv_lg`
  libraryShareRow: () => `pv_lg.folder_path = ''`,
  // folder share `pv_lf` on a folder that document `a` is in
  folderShareRow: (a) => `pv_lf.library_id = ${a}.library_id AND pv_lf.folder_path <> ''
              AND starts_with(${a}.name, pv_lf.folder_path || '/')`,
};

function conditionWith(alias, r) {
  return `(
    ${B.admin(r)}
    OR ${B.uploader(alias, r)}
    OR EXISTS (
      SELECT 1
      FROM document_acl da
      WHERE ${B.fileGrantRow(alias, r)}
        AND da.permission = ANY(${r.perms}::text[])
        AND ${B.fileGrantCounts(alias)}
    )
    OR (${alias}.library_scoped AND (
         ${alias}.library_id IN (
           SELECT pv_lo.id FROM libraries pv_lo
            WHERE ${B.ownerRow(r)}
              AND ${ownerLevel(r)} = ANY(${r.perms}::text[]))
      OR ${alias}.library_id IN (
           SELECT pv_lg.library_id FROM library_grants pv_lg
            WHERE ${B.libraryShareRow()} AND ${shareLevel(r, 'pv_lg.permission')} = ANY(${r.perms}::text[]) AND ${shareSubject('pv_lg', r)})
      OR EXISTS (
           SELECT 1 FROM library_grants pv_lf
            WHERE ${B.folderShareRow(alias)}
              AND ${shareLevel(r, 'pv_lf.permission')} = ANY(${r.perms}::text[]) AND ${shareSubject('pv_lf', r)})
    ))
  )`;
}

function condition(alias = 'd', s = 1) {
  return conditionWith(alias, refsAt(s));
}

async function getAccessibleDocument({ id, user, required = 'read', columns = '*', deleted = 'active' }) {
  const deletedClause = deleted === 'active'
    ? 'AND d.deleted_at IS NULL'
    : deleted === 'deleted'
      ? 'AND d.deleted_at IS NOT NULL'
      : '';
  return db.queryOne(
    `SELECT ${columns}
     FROM documents d
     WHERE d.id = $1
       ${deletedClause}
       AND ${condition('d', 2)}`,
    [id, ...userParams(user, required)]
  );
}

async function grantOwnerAdmin(documentId, user) {
  if (!documentId || !user?.id) return;
  await db.query(
    `INSERT INTO document_acl
     (document_id, subject_type, subject_id, subject_email, permission, granted_by, granted_by_email)
     VALUES ($1, 'user', $2, $3, 'admin', $4, $3)
     ON CONFLICT (document_id, subject_type, subject_id)
     DO UPDATE SET permission = 'admin', subject_email = EXCLUDED.subject_email`,
    [documentId, String(user.id), String(user.email || '').toLowerCase(), user.id]
  );
}

// A file's own access list, as condition() reads it: on library content the uploader's
// owner row counts for nothing (the file belongs to its library), so it is not shown
// as if it did.
async function listGrants(documentId) {
  return db.query(
    `SELECT acl.id, acl.document_id, acl.subject_type, acl.subject_id, acl.subject_email, acl.permission,
            acl.granted_by, acl.granted_by_email, acl.created_at
     FROM document_acl acl
     JOIN documents d ON d.id = acl.document_id
     WHERE acl.document_id = $1
       AND NOT (d.library_scoped AND lower(acl.subject_id) IS NOT DISTINCT FROM d.uploaded_by::text)
     ORDER BY acl.created_at ASC`,
    [documentId]
  );
}

async function grantUserAccess(documentId, { email, permission, grantedBy }) {
  const subjectEmail = normalizeEmail(email);
  if (!subjectEmail || !subjectEmail.includes('@')) throw new Error('Valid user email is required');
  if (!validPermission(permission)) throw new Error('Permission must be read, write, or admin');
  return db.queryOne(
    `INSERT INTO document_acl
     (document_id, subject_type, subject_id, subject_email, permission, granted_by, granted_by_email)
     VALUES ($1, 'user', $2, $2, $3, $4, $5)
     ON CONFLICT (document_id, subject_type, subject_id)
     DO UPDATE SET permission = EXCLUDED.permission,
                   subject_email = EXCLUDED.subject_email,
                   granted_by = EXCLUDED.granted_by,
                   granted_by_email = EXCLUDED.granted_by_email
     RETURNING id, document_id, subject_type, subject_id, subject_email, permission,
               granted_by, granted_by_email, created_at`,
    [
      documentId,
      subjectEmail,
      permission,
      grantedBy?.id || null,
      normalizeEmail(grantedBy?.email),
    ]
  );
}

async function revokeUserAccess(documentId, grantId) {
  return db.queryOne(
    `DELETE FROM document_acl
     WHERE document_id = $1 AND id = $2
     RETURNING id, document_id, subject_type, subject_id, subject_email, permission`,
    [documentId, grantId]
  );
}

// One-time, idempotent: give every existing document an owner/admin grant for its
// uploader. Needed because grantOwnerAdmin historically failed (text-vs-uuid bug),
// so pre-existing documents have no owner-ACL rows. Safe to re-run.
async function backfillOwnerGrants() {
  const rows = await db.query(
    `INSERT INTO document_acl (document_id, subject_type, subject_id, subject_email, permission, granted_by, granted_by_email)
     SELECT d.id, 'user', d.uploaded_by::text, lower(d.uploaded_by_email), 'admin', d.uploaded_by, d.uploaded_by_email
     FROM documents d
     WHERE d.uploaded_by IS NOT NULL
     ON CONFLICT (document_id, subject_type, subject_id) DO NOTHING
     RETURNING document_id`
  );
  return rows.length;
}

// The live identity of an account, by user id, for code that acts on someone's behalf
// without a request of theirs in hand: a public link they created being redeemed, a
// Collabora session they opened, a notification about a file. What such code may do is
// decided against this at the moment it happens, so losing access -- a share removed,
// a group membership ended, a demotion -- takes effect at once instead of whenever the
// link or token expires. (Switching people off, piece 6, will add 'disabled' here.)
//
// The address counts for address-keyed grants only if the identity provider verified
// it (user_roles.verified_email, kept current at every sign-in); otherwise the account
// keeps what is granted to its id -- the files it owns -- and nothing matched by
// address. Null when the account is unknown, which callers treat as no access.
async function resolveActor(userId) {
  if (!userId) return null;
  let row;
  try {
    row = await db.queryOne('SELECT user_id, role, email, verified_email FROM user_roles WHERE user_id = $1', [userId]);
  } catch { return null; }
  if (!row) return null;
  return {
    id: row.user_id,
    role: row.role || '',
    email: row.verified_email || row.email || '',
    emailVerified: !!row.verified_email,
  };
}

// For notifications addressed to people by email: of these addresses, which can still
// read which of these documents. Returns Map(lower(address) -> Set(documentId)).
//
// An address is judged through every account that uses it (by verified or recorded
// address) -- the mail reaches whoever holds that mailbox, so any of their accounts
// being able to read the file is enough. An address with no account at all is judged as
// an anonymous reader holding only what was granted to that address. Anything that goes
// wrong counts as "can't read": a notification is never worth leaking a file name.
async function readersAmong(docIds, emails) {
  const out = new Map();
  const ids = [...new Set((docIds || []).filter(Boolean).map(String))];
  const addrs = [...new Set((emails || []).filter(Boolean).map(e => String(e).toLowerCase()))];
  for (const addr of addrs) out.set(addr, new Set());
  if (!ids.length || !addrs.length) return out;
  for (const addr of addrs) {
    try {
      const accounts = await db.query(
        `SELECT user_id, role, email, verified_email FROM user_roles
          WHERE lower(verified_email) = $1 OR lower(email) = $1`,
        [addr]
      );
      const actors = accounts.length
        ? accounts.map(r => ({ id: r.user_id, role: r.role || '', email: r.verified_email || r.email || '', emailVerified: !!r.verified_email }))
        : [{ id: null, role: '', email: addr }];
      for (const actor of actors) {
        const rows = await db.query(
          `SELECT d.id FROM documents d WHERE d.id = ANY($1::uuid[]) AND d.deleted_at IS NULL AND ${condition('d', 2)}`,
          [ids, ...userParams(actor, 'read')]
        );
        for (const r of rows) out.get(addr).add(String(r.id));
      }
    } catch (e) {
      console.error('readersAmong failed (treated as no access):', e.message);
      out.set(addr, new Set());
    }
  }
  return out;
}

// Documents the user may read whose text is relevant to `query`, ranked by full-text
// relevance (with a name match fallback). Used to ground AI answers in uploaded files.
async function searchAccessibleDocuments(user, query, limit = 6, libraryIds = null) {
  const q = String(query || '').trim();
  if (!q) return [];
  const cap = Math.max(1, Math.min(20, limit));
  const userP = userParams(user, 'read');
  const libIdx = 2 + userP.length; // param slot after $1 (query) and the ACL params
  const libs = Array.isArray(libraryIds) && libraryIds.length ? libraryIds.map(String) : null;
  return db.query(
    `SELECT d.id, d.name, d.document_text
     FROM documents d
     WHERE d.deleted_at IS NULL
       AND d.document_text IS NOT NULL
       AND d.document_text <> ''
       AND (
         d.document_fts @@ websearch_to_tsquery('english', $1)
         OR d.name ILIKE '%' || $1 || '%'
       )
       AND ${condition('d', 2)}
       AND ($${libIdx}::uuid[] IS NULL OR d.library_id = ANY($${libIdx}::uuid[]))
     ORDER BY ts_rank(d.document_fts, websearch_to_tsquery('english', $1)) DESC NULLS LAST, d.created_at DESC
     LIMIT ${cap}`,
    [q, ...userP, libs]
  );
}

module.exports = {
  backfillOwnerGrants,
  searchAccessibleDocuments,
  resolveActor,
  readersAmong,
  getAccessibleDocument,
  grantOwnerAdmin,
  listGrants,
  grantUserAccess,
  revokeUserAccess,
  condition,
  conditionWith,
  refsAt,
  acctRefs,
  verifiedOf,
  shareLevel,
  ownerLevel,
  shareSubject,
  branches: B,
  userParams,
  matchEmail,
  permissionsFor,
  normalizeEmail,
  validPermission,
};
