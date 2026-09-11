-- Piece 3 groundwork ("who has access, and why"). Nothing here changes who can open
-- what.
--
-- Looking up per-file grants by the person they name (Shared with me, the key lists):
-- condition() already compares lower(subject_id), so an index on exactly that.
CREATE INDEX IF NOT EXISTS document_acl_subject_lower_idx ON document_acl (lower(subject_id)) WHERE subject_type = 'user';
-- "My links": a person's own links, newest first.
CREATE INDEX IF NOT EXISTS document_share_links_creator_idx ON document_share_links (created_by, created_at DESC);
-- A per-file grant must name someone. A row with an empty subject would match every
-- account whose address slot is empty (lower('') = ''), i.e. every unverified one. No
-- code writes such a row; this refuses one from now on (NOT VALID: existing rows are
-- not re-checked, and there are none).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_acl_subject_not_blank') THEN
    ALTER TABLE document_acl ADD CONSTRAINT document_acl_subject_not_blank CHECK (subject_id <> '') NOT VALID;
  END IF;
END $$;
