-- Which files are LIBRARY CONTENT: shared along with their library once sharing
-- exists, managed by the library's owner, and no longer their uploader's alone.
--
-- Everything else stays a personal file with exactly today's rules. That is what makes
-- turning on sharing safe on a box that has been running for a while: people uploaded
-- files into libraries when a library was only a label on a list, and believed them
-- private. None of those become visible to anyone by this release or the next -- the
-- only files marked here are an owner's own uploads in their own library.
--
-- The default (false) fails closed: a file is library content only when the code that
-- wrote it says so (libraries.writeRight), and it only ever flips false -> true.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS library_scoped BOOLEAN NOT NULL DEFAULT false;
UPDATE documents d SET library_scoped = true
  FROM libraries l
 WHERE d.library_id = l.id AND l.owner_id IS NOT NULL
   AND d.uploaded_by = l.owner_id AND NOT d.library_scoped;
-- "Libraries where I still have personal files" (the listing rule in the sharing release).
CREATE INDEX IF NOT EXISTS documents_personal_idx ON documents (uploaded_by, library_id)
 WHERE deleted_at IS NULL AND NOT library_scoped;
