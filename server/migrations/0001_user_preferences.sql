-- Per-user preferences that should follow the user across devices/browsers, rather
-- than living only in one browser's localStorage. Currently: pinned libraries and
-- favorite files (both were client-only before).
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id          UUID        PRIMARY KEY,
  pinned_libraries JSONB       NOT NULL DEFAULT '[]'::jsonb,
  favorite_files   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
