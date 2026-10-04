-- One row per verified conversion: the question, every model stage and the answer.
-- See src/lib/replay-log.ts. Rows older than the retention window are pruned by the Worker on every write and by a daily cron.
CREATE TABLE IF NOT EXISTS conversions (
  request_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  status INTEGER NOT NULL,
  refused INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL,
  input TEXT NOT NULL,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversions_created_at ON conversions (created_at);
CREATE INDEX IF NOT EXISTS conversions_outcome ON conversions (outcome, created_at);
