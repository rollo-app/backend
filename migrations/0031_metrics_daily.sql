-- One row per metric per UTC day, written by the cron (`snapshotDailyMetrics`). The panel reads this, never COUNT(*) live.
CREATE TABLE metrics_daily (
  day    TEXT NOT NULL,
  metric TEXT NOT NULL,
  value  INTEGER NOT NULL,
  PRIMARY KEY (day, metric)
);
