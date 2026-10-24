-- 1 while a report/block has not been emailed to support (new rows start at 1 and drop to 0 once the email goes out).
-- The daily summary lists the old ones that stayed at 1 (email skipped by a cap, or Resend failed) and clears them.
ALTER TABLE reports ADD COLUMN unemailed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blocks ADD COLUMN unemailed INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_reports_unemailed ON reports (created_at) WHERE unemailed = 1;
CREATE INDEX idx_blocks_unemailed ON blocks (created_at) WHERE unemailed = 1;
