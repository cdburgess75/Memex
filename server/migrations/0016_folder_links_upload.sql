-- A folder sent to a person can take files BACK.
--
-- File links have had this since 0003 (allow_upload + a per-link ceiling). Folder links never
-- did, so "send them the folder so they can drop their documents in it" had no answer. Only
-- a link sent to a NAMED person (live) may receive: an anonymous link can be forwarded to
-- anyone, and must never become a way for strangers to write into a library.
--
-- What arrives lands in the folder the link points at (or a subfolder of it), belongs to
-- the link's maker, and is accepted only while the maker may still add files there.
ALTER TABLE folder_share_links ADD COLUMN IF NOT EXISTS allow_upload BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE folder_share_links ADD COLUMN IF NOT EXISTS upload_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folder_share_links ADD COLUMN IF NOT EXISTS upload_bytes BIGINT  NOT NULL DEFAULT 0;
