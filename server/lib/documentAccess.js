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
     VALUES ($1, 'user', $2, $3, 'admin', $2, $3)
     ON CONFLICT (document_id, subject_type, subject_id)
     DO UPDATE SET permission = 'admin', subject_email = EXCLUDED.subject_email`,
    [documentId, String(user.id), String(user.email || '').toLowerCase()]
  );
}

function _resetForTests() {
  ensured = false;
}

module.exports = {
  ensureDocumentAclTable,
  getAccessibleDocument,
  grantOwnerAdmin,
  condition,
  userParams,
  permissionsFor,
  _resetForTests,
};
