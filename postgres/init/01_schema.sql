-- Standalone Postgres schema for Memex
-- No auth.users references, no Supabase storage, no RLS with authenticated role.
-- Server enforces all access control via middleware.

-- Activity log
CREATE TABLE IF NOT EXISTS activity_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event       TEXT        NOT NULL,
  user_id     UUID,
  user_email  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- User roles (email stored here since there is no separate auth.users table)
CREATE TABLE IF NOT EXISTS user_roles (
  user_id     UUID        PRIMARY KEY,
  email       TEXT,
  role        TEXT        NOT NULL DEFAULT 'contributor' CHECK (role IN ('admin','contributor','viewer')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by UUID
);

-- API token usage tracking
CREATE TABLE IF NOT EXISTS api_usage (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID,
  user_email    TEXT,
  operation     TEXT        NOT NULL,
  model         TEXT        NOT NULL,
  input_tokens  INTEGER     NOT NULL DEFAULT 0,
  output_tokens INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Document metadata (storage handled by STORAGE_PROVIDER env var)
CREATE TABLE IF NOT EXISTS documents (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  size             BIGINT      NOT NULL DEFAULT 0,
  mime_type        TEXT        NOT NULL,
  storage_path     TEXT        NOT NULL,
  google_drive_id  TEXT,
  document_text    TEXT,
  uploaded_by      UUID,
  uploaded_by_email TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ,
  deleted_by       UUID
);

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS document_text TEXT;

ALTER TABLE documents
  ALTER COLUMN size TYPE BIGINT USING size::bigint;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS deleted_by_email TEXT;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS restored_by UUID;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS restored_by_email TEXT;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS document_fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name,'') || ' ' || coalesce(document_text,''))
  ) STORED;

CREATE INDEX IF NOT EXISTS documents_fts_idx ON documents USING GIN(document_fts);

-- Libraries (shared rooms). Documents belong to one library; the app seeds a
-- default "Ptech Workspace" and backfills existing docs at runtime (lib/libraries.js).
CREATE TABLE IF NOT EXISTS libraries (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  created_by       UUID,
  created_by_email TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS library_id UUID;

CREATE INDEX IF NOT EXISTS documents_library_idx ON documents(library_id);

-- Library membership. Open by default: a library with no members is visible to
-- all signed-in users; once members exist, only members (+admins) can access it.
CREATE TABLE IF NOT EXISTS library_members (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id        UUID        NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  subject_email     TEXT        NOT NULL,
  added_by          UUID,
  added_by_email    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(library_id, subject_email)
);

CREATE INDEX IF NOT EXISTS library_members_library_idx ON library_members(library_id);

-- Per-user profile (display name + avatar) overlaying the Keycloak identity.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id       UUID        PRIMARY KEY,
  email         TEXT,
  display_name  TEXT,
  avatar        TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Document access grants. Uploaders retain owner/admin access; explicit grants
-- make permission checks queryable across list/search/download/AI routes.
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
);

CREATE INDEX IF NOT EXISTS document_acl_document_idx ON document_acl(document_id);
CREATE INDEX IF NOT EXISTS document_acl_subject_idx ON document_acl(subject_type, subject_id);

-- File audit timeline and version history
CREATE TABLE IF NOT EXISTS document_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  UUID        REFERENCES documents(id) ON DELETE SET NULL,
  event_type   TEXT        NOT NULL,
  actor_id     UUID,
  actor_email  TEXT,
  detail       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS document_events_document_idx ON document_events(document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS document_versions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number    INTEGER     NOT NULL,
  name              TEXT        NOT NULL,
  size              BIGINT      NOT NULL DEFAULT 0,
  mime_type         TEXT        NOT NULL,
  storage_path      TEXT        NOT NULL,
  document_text     TEXT,
  saved_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  saved_by          UUID,
  saved_by_email    TEXT,
  source            TEXT        NOT NULL DEFAULT 'replace'
);

CREATE UNIQUE INDEX IF NOT EXISTS document_versions_document_number_idx ON document_versions(document_id, version_number);

-- Resumable upload sessions for local-backed chunked uploads
CREATE TABLE IF NOT EXISTS upload_sessions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  size              BIGINT      NOT NULL DEFAULT 0,
  mime_type         TEXT        NOT NULL,
  storage_path      TEXT        NOT NULL,
  chunk_size        INTEGER     NOT NULL,
  total_chunks      INTEGER     NOT NULL,
  received_chunks   INTEGER[]   NOT NULL DEFAULT '{}',
  received_bytes    BIGINT      NOT NULL DEFAULT 0,
  uploaded_by       UUID,
  uploaded_by_email TEXT,
  status            TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','complete','canceled')),
  document_id       UUID        REFERENCES documents(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS upload_sessions_user_status_idx ON upload_sessions(uploaded_by, status, updated_at DESC);

-- Secure file share links. Raw tokens are shown only at creation; token_hash is stored.
CREATE TABLE IF NOT EXISTS document_share_links (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id          UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  token_hash           TEXT        NOT NULL UNIQUE,
  password_salt        TEXT,
  password_hash        TEXT,
  expires_at           TIMESTAMPTZ,
  revoked_at           TIMESTAMPTZ,
  revoked_by           UUID,
  revoked_by_email     TEXT,
  created_by           UUID,
  created_by_email     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at      TIMESTAMPTZ,
  access_count         INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS document_share_links_document_idx ON document_share_links(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_share_links_active_idx ON document_share_links(token_hash)
  WHERE revoked_at IS NULL;

DROP FUNCTION IF EXISTS search_documents(TEXT);

CREATE OR REPLACE FUNCTION search_documents(query_text TEXT)
RETURNS TABLE(
  id UUID,
  name TEXT,
  size BIGINT,
  mime_type TEXT,
  storage_path TEXT,
  google_drive_id TEXT,
  uploaded_by UUID,
  uploaded_by_email TEXT,
  created_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  deleted_by UUID,
  search_headline TEXT,
  search_rank REAL
) AS $$
  SELECT
    d.id,
    d.name,
    d.size,
    d.mime_type,
    d.storage_path,
    d.google_drive_id,
    d.uploaded_by,
    d.uploaded_by_email,
    d.created_at,
    d.deleted_at,
    d.deleted_by,
    ts_headline(
      'english',
      coalesce(d.document_text, ''),
      websearch_to_tsquery('english', query_text),
      'StartSel=<<, StopSel=>>, MaxFragments=2, MaxWords=18, MinWords=5'
    ) AS search_headline,
    ts_rank(d.document_fts, websearch_to_tsquery('english', query_text)) AS search_rank
  FROM documents d
  WHERE d.deleted_at IS NULL
    AND (
      d.document_fts @@ websearch_to_tsquery('english', query_text)
      OR d.name ILIKE '%' || query_text || '%'
      OR d.uploaded_by_email ILIKE '%' || query_text || '%'
    )
  ORDER BY search_rank DESC NULLS LAST, d.created_at DESC
  LIMIT 50;
$$ LANGUAGE sql STABLE;

-- System settings — admin-configurable key/value pairs (override env vars at runtime)
CREATE TABLE IF NOT EXISTS system_settings (
  key         TEXT        PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID
);
