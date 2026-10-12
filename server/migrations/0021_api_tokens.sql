-- Personal access tokens for the public API (/api/v1). A token acts as the person who
-- made it, limited to the scope chosen when it was made. Only its hash is stored; the
-- token itself is shown once. token_prefix is the first characters, for telling tokens
-- apart in a list without revealing them.
CREATE TABLE IF NOT EXISTS api_tokens (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL,
  name          TEXT        NOT NULL,
  token_hash    TEXT        NOT NULL UNIQUE,
  token_prefix  TEXT        NOT NULL,
  scope         TEXT        NOT NULL CHECK (scope IN ('read', 'write', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_by    UUID
);
CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens (user_id, created_at DESC);
