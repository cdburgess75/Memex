-- External storage connectors: live pass-through mounts into systems Depot does not
-- own — SMB/CIFS (an NTFS file server), SharePoint, and the providers that follow.
--
-- Pass-through, not copy: nothing is ingested into `documents`. The remote system
-- stays the source of truth and Depot browses and streams on demand, so a file
-- changed on the file server is immediately what Depot serves. That keeps the
-- connector free of sync state, conflict resolution, and a second copy of the data
-- the customer already has (and already backs up).
--
-- `config` holds non-secret settings (host, share, site URL, root path). Credentials
-- live in `secret`, encrypted with the same AES-256-GCM envelope used for file blobs
-- (server/lib/encryption.js) so a database dump alone does not surrender them.
CREATE TABLE IF NOT EXISTS storage_connectors (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  kind            TEXT        NOT NULL,
  config          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  secret          BYTEA,
  enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Mount read-only by default is the safe posture for a system Depot does not own:
  -- an operator opts in to writes deliberately, per connector.
  read_only       BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Result of the last "Test connection" run, surfaced in Settings so a broken mount
  -- is visible before a user trips over it.
  last_status     TEXT,
  last_error      TEXT,
  last_checked_at TIMESTAMPTZ,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS storage_connectors_enabled_idx ON storage_connectors (enabled);
