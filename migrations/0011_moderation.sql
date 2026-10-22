-- Moderation: reports (of a photo or of a person) and user blocks.
-- reports.media_id is null for a report of a person; trip_id is kept as plain text (no FK) so a report outlives its trip context.

CREATE TABLE reports (
  id             TEXT PRIMARY KEY,
  reporter_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id       TEXT REFERENCES media(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id        TEXT,
  reason         TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_reports_media ON reports (reporter_id, media_id) WHERE media_id IS NOT NULL;
CREATE UNIQUE INDEX idx_reports_user ON reports (reporter_id, target_user_id) WHERE media_id IS NULL;

CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX idx_blocks_blocked ON blocks (blocked_id);
