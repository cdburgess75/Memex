-- Retention policies and legal holds (lib/retention.js).
--
-- A library can say how long its files must be kept (retention_min_years: nothing in it
-- is purged from the Trash before a file is that old -- IRC §6107 asks tax preparers for
-- three years, HIPAA for six) and, optionally, when files nobody has touched are moved to
-- the Trash on their own (retention_dispose_years). Both NULL means what Depot did before:
-- the Trash empties after trash_retention_days and nothing is disposed of unasked.
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS retention_min_years INTEGER;
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS retention_dispose_years INTEGER;
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS retention_set_at TIMESTAMPTZ;
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS retention_set_by_email TEXT;

-- When the owner was told a file is about to be disposed of. Disposal waits 30 days after
-- this, so the notice is always in advance; NULL means no notice has gone out.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS disposal_notice_at TIMESTAMPTZ;

-- A legal hold: while one covers a document, nothing can delete it, purge it, replace its
-- bytes or move it out of where it is -- not an administrator, not the Trash sweeper, not
-- the disposal job. A hold covers one document, every document under a folder of a library
-- (by name prefix), or a whole library. Releasing one keeps the row, with who and why.
CREATE TABLE IF NOT EXISTS legal_holds (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope             TEXT        NOT NULL CHECK (scope IN ('library', 'folder', 'document')),
  library_id        UUID,
  folder_path       TEXT,
  document_id       UUID,
  reason            TEXT        NOT NULL,
  placed_by         UUID,
  placed_by_email   TEXT,
  placed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at       TIMESTAMPTZ,
  released_by       UUID,
  released_by_email TEXT,
  release_note      TEXT
);
-- Asked on every delete, purge, replace and move: only the open holds matter.
CREATE INDEX IF NOT EXISTS legal_holds_active_idx ON legal_holds (library_id, document_id) WHERE released_at IS NULL;
