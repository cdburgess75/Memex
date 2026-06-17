'use strict';
const db = require('./db');

const PERMISSION_LEVELS = {
  read: ['read', 'write', 'admin'],
  write: ['write', 'admin'],
  admin: ['admin'],
};

let ensured = false;

async function ensureDocumentAclTable() {
  if (ensured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS document_acl (
      id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id          UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      subject_type         TEXT        NOT NULL DEFAULT 'user' CHECK (subject_type IN ('user')),
      subject_id           TEXT        NOT NULL,
      subject_email        TEXT,
      permission           TEXT        NOT NULL CHECK (permission IN ('read','write','admin')),
      granted_by           UUID,
      granted_by_email     TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(document_id, subject_type, subject_id)
    )
  `);
  await db.query('CREATE INDEX IF NOT EXISTS document_acl_document_idx ON document_acl(document_id)');
  await db.query('CREATE INDEX IF NOT EXISTS document_acl_subject_idx ON document_acl(subject_type, subject_id)');
  ensured = true;
}

function permissionsFor(required = 'read') {
  return PERMISSION_LEVELS[required] || PERMISSION_LEVELS.read;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validPermission(permission) {
  return Object.prototype.hasOwnProperty.call(PERMISSION_LEVELS, permission);
}

function userParams(user, required = 'read') {
  return [
    user?.role || '',
    user?.id || null,
    String(user?.id || ''),
    String(user?.email || '').toLowerCase(),
    permissionsFor(required),
  ];
}

function condition(alias = 'd', startIndex = 1) {
  return `(
    $${startIndex} = 'admin'
    OR ${alias}.uploaded_by = $${startIndex + 1}
    OR EXISTS (
      SELECT 1
      FROM document_acl da
      WHERE da.document_id = ${alias}.id
        AND da.subject_type = 'user'
        AND lower(da.subject_id) IN (lower($${startIndex + 2}), lower($${startIndex + 3}))
        AND da.permission = ANY($${startIndex + 4}::text[])
    )
  )`;
}

async function getAccessibleDocument({ id, user, required = 'read', columns = '*', deleted = 'active' }) {
  await ensureDocumentAclTable();
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
  await ensureDocumentAclTable();
  await db.query(
    `INSERT INTO document_acl
     (document_id, subject_type, subject_id, subject_email, permission, granted_by, granted_by_email)
     VALUES ($1, 'user', $2, $3, 'admin', $4, $3)
     ON CONFLICT (document_id, subject_type, subject_id)
     DO UPDATE SET permission = 'admin', subject_email = EXCLUDED.subject_email`,
    [documentId, String(user.id), String(user.email || '').toLowerCase(), user.id]
  );
}

async function listGrants(documentId) {
  await ensureDocumentAclTable();
  return db.query(
    `SELECT id, document_id, subject_type, subject_id, subject_email, permission,
            granted_by, granted_by_email, created_at
     FROM document_acl
     WHERE document_id = $1
     ORDER BY created_at ASC`,
    [documentId]
  );
}

async function grantUserAccess(documentId, { email, permission, grantedBy }) {
  const subjectEmail = normalizeEmail(email);
  if (!subjectEmail || !subjectEmail.includes('@')) throw new Error('Valid user email is required');
  if (!validPermission(permission)) throw new Error('Permission must be read, write, or admin');
  await ensureDocumentAclTable();
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
  await ensureDocumentAclTable();
  return db.queryOne(
    `DELETE FROM document_acl
     WHERE document_id = $1 AND id = $2
     RETURNING id, document_id, subject_type, subject_id, subject_email, permission`,
    [documentId, grantId]
  );
}

function _resetForTests() {
  ensured = false;
}

// One-time, idempotent: give every existing document an owner/admin grant for its
// uploader. Needed because grantOwnerAdmin historically failed (text-vs-uuid bug),
// so pre-existing documents have no owner-ACL rows. Safe to re-run.
async function backfillOwnerGrants() {
  await ensureDocumentAclTable();
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

// Documents the user may read whose text is relevant to `query`, ranked by full-text
// relevance (with a name match fallback). Used to ground AI answers in uploaded files.
async function searchAccessibleDocuments(user, query, limit = 6) {
  await ensureDocumentAclTable();
  const q = String(query || '').trim();
  if (!q) return [];
  const cap = Math.max(1, Math.min(20, limit));
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
     ORDER BY ts_rank(d.document_fts, websearch_to_tsquery('english', $1)) DESC NULLS LAST, d.created_at DESC
     LIMIT ${cap}`,
    [q, ...userParams(user, 'read')]
  );
}

module.exports = {
  ensureDocumentAclTable,
  backfillOwnerGrants,
  searchAccessibleDocuments,
  getAccessibleDocument,
  grantOwnerAdmin,
  listGrants,
  grantUserAccess,
  revokeUserAccess,
  condition,
  userParams,
  permissionsFor,
  normalizeEmail,
  validPermission,
  _resetForTests,
};
