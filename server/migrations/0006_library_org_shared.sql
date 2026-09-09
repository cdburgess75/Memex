-- Org-shared libraries.
--
-- Until now a library was a label, not a permission boundary: library_members
-- decided only whether a library appeared in the switcher, while access to the
-- documents inside it came solely from document_acl, the uploader column, or the
-- admin role. The result was a library that looked shared and read as empty.
--
-- org_shared marks a library every signed-in member of the workspace can work in,
-- with the same rights as the owner. It is an explicit flag rather than something
-- inferred from an empty member list, so "shared with everyone" is always a
-- decision somebody made and can be seen in the schema.
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS org_shared BOOLEAN NOT NULL DEFAULT false;

-- The predicate in lib/documentAccess.js joins documents to this flag on every
-- read, so the lookup is on the hot path for every file listing.
CREATE INDEX IF NOT EXISTS libraries_org_shared_idx ON libraries(id) WHERE org_shared;
