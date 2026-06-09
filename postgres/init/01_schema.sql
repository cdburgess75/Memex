-- Standalone Postgres schema for Memex
-- No auth.users references, no Supabase storage, no RLS with authenticated role.
-- Server enforces all access control via middleware.

-- Pages
CREATE TABLE IF NOT EXISTS pages (
  id          TEXT        PRIMARY KEY,
  title       TEXT        NOT NULL,
  category    TEXT        NOT NULL DEFAULT 'concept',
  content     TEXT        NOT NULL DEFAULT '',
  sources     INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  UUID,
  updated_by  UUID
);

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

-- Full-text search
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS content_fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))
  ) STORED;

CREATE INDEX IF NOT EXISTS pages_fts_idx ON pages USING GIN(content_fts);

CREATE OR REPLACE FUNCTION search_pages(query_text TEXT)
RETURNS TABLE(id TEXT, title TEXT, category TEXT, headline TEXT) AS $$
  SELECT
    p.id,
    p.title,
    p.category,
    ts_headline(
      'english',
      p.content,
      websearch_to_tsquery('english', query_text),
      'StartSel=<<, StopSel=>>, MaxFragments=2, MaxWords=15, MinWords=5'
    ) AS headline
  FROM pages p
  WHERE p.content_fts @@ websearch_to_tsquery('english', query_text)
  ORDER BY ts_rank(p.content_fts, websearch_to_tsquery('english', query_text)) DESC
  LIMIT 20;
$$ LANGUAGE sql STABLE;

-- Page version history
CREATE TABLE IF NOT EXISTS page_versions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         TEXT        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  title           TEXT        NOT NULL,
  category        TEXT        NOT NULL,
  content         TEXT        NOT NULL,
  saved_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  saved_by        UUID,
  saved_by_email  TEXT
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
