-- Operator switches changed by a person from the panel (e.g. degraded_mode); cron_state stays for cron bookkeeping.
CREATE TABLE app_settings (
  key                TEXT PRIMARY KEY,
  value              TEXT NOT NULL,
  updated_at         INTEGER NOT NULL,
  updated_by_user_id TEXT
);
