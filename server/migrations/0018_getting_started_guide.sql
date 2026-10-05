-- The getting-started guide is copied once into each personal library: when the library
-- is made at a person's first sign-in, and, for libraries that already existed, by a pass
-- at startup. Two stamps:
--   getting_started_claimed_at  someone is adding it right now. A claim older than a few
--                               minutes is abandoned (the process died mid-way) and may be
--                               taken again, so a crash never leaves a library without it.
--   getting_started_at          it has been added. Set only after the file is in place,
--                               so a person who later deletes the guide never gets it back.
-- Numbered 0018 so it never shares a number with a sibling branch's 0017.
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS getting_started_at TIMESTAMPTZ;
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS getting_started_claimed_at TIMESTAMPTZ;
