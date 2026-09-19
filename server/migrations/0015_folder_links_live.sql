-- Folder links that go to a PERSON, and show the folder as it is now.
--
-- A folder link was one thing: an anonymous URL that downloaded a ZIP of the files that
-- were in the folder when the link was made. Two more are needed.
--
--   recipient_email   A link sent to one named person, so "did they open it?" has an answer
--                     and one person can be cut off without breaking the others -- the same
--                     reason files have per-recipient links.
--   live              A named person sees the folder as it is NOW: a file added next week is
--                     there. An anonymous link stays a frozen snapshot (document_ids),
--                     because it can be forwarded to anyone and must never start publishing
--                     files that were not there when its maker chose to publish.
--   library_id        A live link has to know WHICH folder it means; until now a folder
--                     link carried no library, only a label and a list of ids.
--   require_signin    As for file links (0014): sent to a colleague by someone who may share
--                     the folder but not hand out access to it. Opens for that colleague,
--                     signed in, and for nobody else.
--
-- Either way a link only ever serves what its MAKER can still publish, checked when it is
-- used (lib/linkAccess, lib/folderLinks): a maker who loses access takes the link down.
ALTER TABLE folder_share_links ADD COLUMN IF NOT EXISTS recipient_email TEXT;
ALTER TABLE folder_share_links ADD COLUMN IF NOT EXISTS live            BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE folder_share_links ADD COLUMN IF NOT EXISTS library_id      UUID;
ALTER TABLE folder_share_links ADD COLUMN IF NOT EXISTS require_signin  BOOLEAN NOT NULL DEFAULT false;

-- A live link is found by the folder it points at when that folder is renamed, moved or
-- deleted (lib/folderCarry). Few rows; partial so the many snapshot links cost nothing.
CREATE INDEX IF NOT EXISTS folder_share_links_live_idx ON folder_share_links (library_id, folder_path) WHERE live;
