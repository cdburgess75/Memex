-- The health journal (lib/health.js): what the server could not do for people, kept where an
-- administrator can read it (Admin › Health, GET /api/admin/health) instead of in container
-- logs. Two kinds: 'error', a request the server could not finish (a 5xx), and 'refusal', a
-- request it turned away on purpose (413 too big, 415 a refused file type, 429 too many at
-- once). Rows older than 30 days are swept by the same module.
CREATE TABLE IF NOT EXISTS health_events (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  status INTEGER,
  method TEXT,
  path TEXT,
  message TEXT,
  actor_email TEXT
);
CREATE INDEX IF NOT EXISTS health_events_at_idx ON health_events (at DESC);
