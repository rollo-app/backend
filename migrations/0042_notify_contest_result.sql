-- Preference for the photo contest pushes (finalists to pick, reminder, tie, cancel and winner). On by default.
ALTER TABLE user_settings ADD COLUMN notify_contest_result INTEGER NOT NULL DEFAULT 1;
