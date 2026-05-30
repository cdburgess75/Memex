CREATE TABLE IF NOT EXISTS page_versions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         TEXT        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  title           TEXT        NOT NULL,
  category        TEXT        NOT NULL,
  content         TEXT        NOT NULL,
  saved_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  saved_by        UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  saved_by_email  TEXT
);

ALTER TABLE page_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read_versions"   ON page_versions FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert_versions" ON page_versions FOR INSERT TO authenticated WITH CHECK (true);
