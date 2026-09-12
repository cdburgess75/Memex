-- Switching people off.
--
-- Until now Depot had no "off". The only thing an account could be was a role -- admin,
-- contributor or viewer -- and the nearest thing to removing somebody was demoting them
-- to viewer, which still let them read everything they had ever been given. Deleting the
-- user_roles row was worse than nothing: the next valid token puts it straight back as a
-- contributor, with their libraries (matched by owner id, which survived) intact.
--
-- A timestamp rather than a boolean, so the row carries its own history: when, who did
-- it, and why. Switching somebody back on clears all three.
--
-- What this file adds is the FACT. What reads it is the next part: sign-in refuses, and
-- resolveActor -- the one place the rest of the system asks "who is this account, really"
-- -- answers with nothing, which is what kills their public links, their editing sessions
-- and anything else still acting on their behalf.

ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS disabled_at     TIMESTAMPTZ;
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS disabled_by     UUID;
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

-- Asked on every request that resolves an account, so it is worth an index even on a
-- table this small; partial, because the answer is almost always "nobody".
CREATE INDEX IF NOT EXISTS user_roles_disabled_idx ON user_roles (user_id) WHERE disabled_at IS NOT NULL;
