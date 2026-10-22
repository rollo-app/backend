-- Expo push tickets waiting for their receipt. The cron asks for receipts ~15 min after sending
-- and deletes the token when Expo says DeviceNotRegistered. No FK: the token may be gone already.
CREATE TABLE push_receipts (
  id         TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_push_receipts_created ON push_receipts (created_at);
