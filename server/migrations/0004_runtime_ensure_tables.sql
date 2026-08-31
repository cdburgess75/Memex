-- Consolidate the historical runtime "ensure*" DDL into one recorded migration.
--
-- Until now, many tables were created lazily at runtime by idempotent
-- CREATE/ALTER IF NOT EXISTS helpers scattered through the app (lib/profiles.js,
-- lib/notifications.js, lib/libraries.js, lib/documentAccess.js, lib/docFollows.js,
-- lib/folderNotifyPrefs.js, lib/compliance.js, lib/auditLog.js, routes/files.js).
-- This migration carries the exact same DDL, so:
--   * a database those helpers already touched sees only no-ops, and
--   * a database that never ran them (fresh install, or a box that skipped a
--     feature) gets the full schema deterministically at startup.
-- The runtime helpers are removed in the same change; this file is now the
-- single source of truth for this part of the schema. The base tables
-- (documents, document_events, …) come from postgres/init/01_schema.sql and are
-- present on every deployed box before the app first connects.

-- ── Per-user profiles (display name + avatar overlaying the Keycloak identity) ──
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id       UUID        PRIMARY KEY,
  email         TEXT,
  display_name  TEXT,
  avatar        TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Notifications opt-out pref lives on the profile row.
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ── In-app notifications (recipients matched by user_id OR email) ──
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID,
  user_email  TEXT,
  type        TEXT        NOT NULL,
  title       TEXT        NOT NULL,
  body        TEXT,
  ref_type    TEXT,
  ref_id      TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_email_idx ON notifications (lower(user_email), created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

-- ── Libraries (shared rooms) + membership ──
CREATE TABLE IF NOT EXISTS libraries (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  created_by       UUID,
  created_by_email TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS library_id UUID;
CREATE INDEX IF NOT EXISTS documents_library_idx ON documents(library_id);
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
-- Seed the default library and adopt any documents that predate libraries —
-- previously done per-boot by lib/libraries.js ensureLibraries().
INSERT INTO libraries (name)
SELECT 'Ptech Workspace'
WHERE NOT EXISTS (SELECT 1 FROM libraries);
UPDATE documents
SET library_id = (SELECT id FROM libraries ORDER BY created_at ASC LIMIT 1)
WHERE library_id IS NULL;

-- ── Document access grants (queryable permission checks) ──
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

-- ── Resumable chunked-upload sessions ──
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

-- ── Per-file share links (tokens stored hashed) ──
-- Includes the per-recipient columns from 0003, which no-ops when this table is
-- absent; created here fresh, the table carries them from the start, and the
-- recipient index 0003 would have added is created below.
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
  recipient_email      TEXT,
  allow_upload         BOOLEAN     NOT NULL DEFAULT FALSE,
  upload_count         INTEGER     NOT NULL DEFAULT 0,
  upload_bytes         BIGINT      NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at      TIMESTAMPTZ,
  access_count         INTEGER     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS document_share_links_document_idx ON document_share_links(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_share_links_active_idx ON document_share_links(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS document_share_links_recipient_idx
  ON document_share_links (lower(recipient_email), created_at DESC)
  WHERE recipient_email IS NOT NULL;

-- ── Whole-folder share links (frozen document_ids snapshot) ──
CREATE TABLE IF NOT EXISTS folder_share_links (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_path          TEXT        NOT NULL,
  document_ids         UUID[]      NOT NULL DEFAULT '{}',
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
CREATE INDEX IF NOT EXISTS folder_share_links_creator_idx ON folder_share_links(created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS folder_share_links_active_idx ON folder_share_links(token_hash) WHERE revoked_at IS NULL;

-- ── Inbound upload links (file requests from non-members) ──
CREATE TABLE IF NOT EXISTS upload_links (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash        TEXT        NOT NULL UNIQUE,
  label             TEXT,
  library_id        UUID,
  folder_path       TEXT,
  password_salt     TEXT,
  password_hash     TEXT,
  expires_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  created_by        UUID,
  created_by_email  TEXT,
  notify_email      BOOLEAN     NOT NULL DEFAULT TRUE,
  notify_alert      BOOLEAN     NOT NULL DEFAULT TRUE,
  upload_count      INTEGER     NOT NULL DEFAULT 0,
  last_used_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Older boxes created the table before the notify columns existed.
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE upload_links ADD COLUMN IF NOT EXISTS notify_alert BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS upload_links_active_idx ON upload_links(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS upload_links_owner_idx ON upload_links(created_by, created_at DESC);

-- ── Per-user "recently opened" tracking ──
CREATE TABLE IF NOT EXISTS recent_opens (
  user_id UUID NOT NULL, document_id UUID NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, document_id)
);
CREATE INDEX IF NOT EXISTS recent_opens_user_idx ON recent_opens(user_id, opened_at DESC);

-- ── Manual compliance attestations ──
CREATE TABLE IF NOT EXISTS compliance_attestations (
  control_id        TEXT PRIMARY KEY,
  met               BOOLEAN NOT NULL DEFAULT false,
  note              TEXT,
  attested_by       UUID,
  attested_by_email TEXT,
  attested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Per-user folder/library new-file notification overrides ──
CREATE TABLE IF NOT EXISTS folder_notify_prefs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id       UUID,
  folder_path      TEXT        NOT NULL DEFAULT '',
  subscriber_email TEXT        NOT NULL,
  enabled          BOOLEAN     NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Expression index; lib/folderNotifyPrefs.js infers ON CONFLICT against this
-- exact expression, so it must stay in sync with setPref().
CREATE UNIQUE INDEX IF NOT EXISTS folder_notify_prefs_uniq
  ON folder_notify_prefs (COALESCE(library_id, '00000000-0000-0000-0000-000000000000'), folder_path, lower(subscriber_email));
CREATE INDEX IF NOT EXISTS folder_notify_prefs_lib_idx ON folder_notify_prefs(library_id);

-- ── "Follow this file" subscriptions ──
CREATE TABLE IF NOT EXISTS document_follows (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  subscriber_email TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS document_follows_uniq ON document_follows(document_id, lower(subscriber_email));
CREATE INDEX IF NOT EXISTS document_follows_doc_idx ON document_follows(document_id);

-- ── documents.content_hash (U6 re-upload dedupe) ──
-- Nullable TEXT + a partial index: metadata-only, instant even on a large table.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash TEXT;
CREATE INDEX IF NOT EXISTS documents_content_hash_idx ON documents(library_id, content_hash) WHERE content_hash IS NOT NULL AND deleted_at IS NULL;

-- ── Tamper-evident audit-log chain columns on document_events ──
-- chain_seq is BIGINT + an explicit sequence default, NOT BIGSERIAL: adding a
-- BIGSERIAL column rewrites the whole table (its nextval default is volatile),
-- whereas ADD COLUMN BIGINT is a metadata-only change and SET DEFAULT only
-- affects future inserts. Pre-existing rows keep chain_seq NULL (harmless —
-- they also have hash NULL and are excluded from the chain).
ALTER TABLE document_events ADD COLUMN IF NOT EXISTS chain_seq BIGINT;
CREATE SEQUENCE IF NOT EXISTS document_events_chain_seq OWNED BY document_events.chain_seq;
ALTER TABLE document_events ALTER COLUMN chain_seq SET DEFAULT nextval('document_events_chain_seq');
ALTER TABLE document_events ADD COLUMN IF NOT EXISTS prev_hash TEXT;
ALTER TABLE document_events ADD COLUMN IF NOT EXISTS hash TEXT;
ALTER TABLE document_events ADD COLUMN IF NOT EXISTS ts_ms BIGINT;
-- Partial index so the head lookup (DESC LIMIT 1) and verify walk (ASC) are
-- index scans, not full-table seq scans held under the append lock.
CREATE INDEX IF NOT EXISTS document_events_chain_idx ON document_events (chain_seq) WHERE hash IS NOT NULL;
-- document_id is part of the hashed row, so it must never change after append.
-- The original FK used ON DELETE SET NULL, which silently rewrote document_id
-- (and thus broke the chain) whenever a document was purged. Drop the FK so a
-- purge leaves audit rows untouched; a dangling document_id is expected and
-- correct for an append-only, tamper-evident log (the admin feed LEFT JOINs).
ALTER TABLE document_events DROP CONSTRAINT IF EXISTS document_events_document_id_fkey;
