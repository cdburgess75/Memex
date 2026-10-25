-- "Pin for everyone in this group": a whole-library share with a group can also put the
-- library in each member's pinned list, once. The member can unpin it, and it does not
-- come back.
--
-- The default lives on the share itself, so it ends with the share: remove the group's
-- share and nobody new is given the pin (pins already given stay; they are the person's).
-- Only a group share of the whole library (folder_path '') can carry it -- a pin opens a
-- library, and a folder share does not let anyone open the library's root.
ALTER TABLE library_grants ADD COLUMN IF NOT EXISTS pin_by_default BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  ALTER TABLE library_grants ADD CONSTRAINT library_grants_pin_whole_group
    CHECK (NOT pin_by_default OR (subject_type = 'group' AND folder_path = ''));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The defaults a person has been given, one row per person per library, whichever group
-- it came through. A row here means "done": it is never given again, so an unpin sticks,
-- even if the share is removed and made again or they join a second group with the same
-- default.
CREATE TABLE IF NOT EXISTS pin_defaults_applied (
  user_id     UUID        NOT NULL,
  library_id  UUID        NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, library_id)
);
