-- Sensitive data found in files (lib/sensitiveData.js): one row per document and type
-- (card, ssn, bank) with a count and a sample masked to its last four digits; never the
-- value. resolved_at is set when an administrator marks it handled (resolved_by is their
-- address) or when the number is no longer in the file (resolved_by 'depot').
-- documents.sensitive_checked_at says when a file's text was last checked, so the one-time
-- check of existing files can pick up where it left off.
CREATE TABLE IF NOT EXISTS document_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  sample TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  note TEXT,
  UNIQUE (document_id, type)
);
CREATE INDEX IF NOT EXISTS document_findings_open_idx ON document_findings (type, first_seen DESC) WHERE resolved_at IS NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sensitive_checked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS documents_sensitive_unchecked_idx ON documents (created_at) WHERE deleted_at IS NULL AND sensitive_checked_at IS NULL;
