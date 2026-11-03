-- Past compliance reports (lib/complianceReports.js): one row per report an administrator
-- downloaded or the schedule produced, with the printable HTML kept whole so a report can
-- be fetched again as it was on the day. generated_by is the administrator's address, or
-- 'schedule'. status is 'ready' when every requirement was met, else 'to do'.
CREATE TABLE IF NOT EXISTS compliance_reports (
  id BIGSERIAL PRIMARY KEY,
  framework TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by TEXT NOT NULL,
  status TEXT NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  html TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS compliance_reports_generated_at_idx ON compliance_reports (generated_at DESC);
