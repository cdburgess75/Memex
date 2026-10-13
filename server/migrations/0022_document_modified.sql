-- Public API, release 3: when a file's bytes last changed. NULL means not since it was
-- created (the API answers created_at then). Set wherever bytes change: a save from the
-- built-in editor and a replace through the API (routes/files.js), an Office save
-- (routes/wopi.js), and a restored version. documents.content_hash, which existed but was
-- written only when a file was created through one path, is kept current at the same
-- places from now on, and every upload path computes it.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS modified_at TIMESTAMPTZ;
