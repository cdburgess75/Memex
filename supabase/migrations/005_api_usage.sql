CREATE TABLE IF NOT EXISTS api_usage (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email    TEXT,
  operation     TEXT        NOT NULL,
  model         TEXT        NOT NULL,
  input_tokens  INTEGER     NOT NULL DEFAULT 0,
  output_tokens INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE api_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read_usage"   ON api_usage FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert_usage" ON api_usage FOR INSERT TO authenticated WITH CHECK (true);
