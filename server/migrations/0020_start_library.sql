-- The library a person wants open when they sign in ("Open this library when I sign in"
-- in the library menu). NULL: whichever library this browser had open last, as before.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS start_library TEXT;
