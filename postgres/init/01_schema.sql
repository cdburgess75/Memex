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
  size             INTEGER     NOT NULL DEFAULT 0,
  mime_type        TEXT        NOT NULL,
  storage_path     TEXT        NOT NULL,
  google_drive_id  TEXT,
  uploaded_by      UUID,
  uploaded_by_email TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ,
  deleted_by       UUID
);

-- System settings — admin-configurable key/value pairs (override env vars at runtime)
CREATE TABLE IF NOT EXISTS system_settings (
  key         TEXT        PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID
);
