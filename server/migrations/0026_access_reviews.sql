-- Access-review sign-offs (lib/accessReview signoff/history): proof that an administrator
-- looked at who has access and when. Each row keeps the whole list as it stood (snapshot),
-- so a later reviewer can see what was signed. The chained event access_reviewed in
-- document_events records the same moment. Rows are never updated or deleted by the app.
CREATE TABLE IF NOT EXISTS access_reviews (
  id BIGSERIAL PRIMARY KEY,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by_email TEXT,
  reviewed_by TEXT,
  user_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS access_reviews_reviewed_at_idx ON access_reviews (reviewed_at DESC);
