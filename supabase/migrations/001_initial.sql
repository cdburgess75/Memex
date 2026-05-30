-- Wiki pages
CREATE TABLE IF NOT EXISTS pages (
  id          TEXT        PRIMARY KEY,
  title       TEXT        NOT NULL,
  category    TEXT        NOT NULL DEFAULT 'concept',
  content     TEXT        NOT NULL DEFAULT '',
  sources     INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Activity log (user_email denormalized for easy display without joining auth.users)
CREATE TABLE IF NOT EXISTS activity_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event       TEXT        NOT NULL,
  user_id     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Row-level security: authenticated users can read/write all pages
ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read_pages"   ON pages FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert_pages" ON pages FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update_pages" ON pages FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth_delete_pages" ON pages FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth_read_log"   ON activity_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert_log" ON activity_log FOR INSERT TO authenticated WITH CHECK (true);
