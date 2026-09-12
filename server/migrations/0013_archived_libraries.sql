-- Archiving a library.
--
-- The other half of switching somebody off is deciding what becomes of what they held.
-- For a library somebody SHARED, that is a handover: the company's files need an owner
-- who is still here. For the library that was theirs alone, there is nobody to hand it
-- to -- and deleting it would destroy the only copy of whatever they had parked in it.
--
-- So it is archived: kept exactly as it is, out of everybody's way. Nothing can be added
-- to it, it is not listed to anyone but an administrator, and whoever could read what is
-- in it still can. Switching the person back on brings it back with them.
--
-- A timestamp, not a boolean, for the same reason as disabled_at: the row carries its own
-- history rather than needing a separate log to explain it.

ALTER TABLE libraries ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS archived_by UUID;

-- Read on every listing and every write right, and almost always NULL.
CREATE INDEX IF NOT EXISTS libraries_archived_idx ON libraries (id) WHERE archived_at IS NOT NULL;
