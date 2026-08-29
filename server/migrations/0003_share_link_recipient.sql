-- Send a file to someone outside the organization, and let them send files back.
--
-- Columns that turn a share link into a per-recipient, two-way exchange:
--   recipient_email  — sending to three people mints THREE links, so the audit
--                      trail answers "did the client open it?" and one recipient
--                      can be cut off without breaking the others. NULL = an
--                      anonymous "copy a link" link, which has no recipient.
--   allow_upload     — whether the recipient may also drop files back. Off by
--                      default so every pre-existing link stays download-only.
--   upload_count/    — per-link inbound ceiling, so one link cannot be used to
--   upload_bytes       push unbounded data onto the box.
--
-- Guarded by to_regclass: the table is created lazily by ensureShareLinksTable
-- on boxes that predate its inclusion in the init schema, so a bare ALTER would
-- hit "relation does not exist" and crash-loop the migrator. When the table is
-- absent, ensureShareLinksTable creates it already carrying these columns, so
-- there is nothing to do here.
DO $$
BEGIN
  IF to_regclass('public.document_share_links') IS NOT NULL THEN
    ALTER TABLE document_share_links ADD COLUMN IF NOT EXISTS recipient_email TEXT;
    ALTER TABLE document_share_links ADD COLUMN IF NOT EXISTS allow_upload BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE document_share_links ADD COLUMN IF NOT EXISTS upload_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE document_share_links ADD COLUMN IF NOT EXISTS upload_bytes BIGINT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS document_share_links_recipient_idx
      ON document_share_links (lower(recipient_email), created_at DESC)
      WHERE recipient_email IS NOT NULL;
  END IF;
END $$;
