-- Small key/value store for cron jobs that resume across runs (e.g. where the avatar sweep stopped).
CREATE TABLE cron_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
