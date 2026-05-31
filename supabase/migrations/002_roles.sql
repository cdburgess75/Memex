CREATE TABLE IF NOT EXISTS user_roles (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'contributor' CHECK (role IN ('admin','contributor','viewer')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read_roles"   ON user_roles FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert_roles" ON user_roles FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update_roles" ON user_roles FOR UPDATE TO authenticated USING (true);
