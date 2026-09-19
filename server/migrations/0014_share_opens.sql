-- "Did they open it?"
--
-- Sharing told the sharer about exactly one thing: a DOWNLOAD through an anonymous link.
-- Looking at the link's page told them nothing, and a colleague opening a file they had
-- been given told them nothing either. The question a sharer actually has is the first
-- one -- did Amy look at it -- so each share remembers the first time its recipient did.
--
-- A timestamp on the share itself, set once (UPDATE ... WHERE opened_at IS NULL): that one
-- statement is both the record and the "only the first time" rule, with no race between
-- two tabs opening the same link.
ALTER TABLE document_share_links ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;
ALTER TABLE folder_share_links   ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;
ALTER TABLE document_acl         ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;
ALTER TABLE library_grants       ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;

-- A link sent to a COLLEAGUE by someone who may share the file but not hand out access to
-- it. It opens only for that colleague, signed in -- never from the public link page --
-- so an internal file stays behind the sign-in it already had, and forwarding the email
-- gives nobody else anything.
ALTER TABLE document_share_links ADD COLUMN IF NOT EXISTS require_signin BOOLEAN NOT NULL DEFAULT false;

-- A notification about a FOLDER needs to say which one, so that opening it lands there
-- and not at the top of the library.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS ref_path TEXT;
