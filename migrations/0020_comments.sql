-- Comments on revealed photos.
-- comments: soft-deleted (deleted_at) so a report of a deleted comment still has its text; ON DELETE CASCADE with the photo or the user.
-- reports.comment_id: a report of a comment (media_id stays null, so the photo is not hidden from the reporter). The report of a
--   person (idx_reports_user) now only covers rows with neither media nor comment, otherwise it would collide with them.
-- media.comment_notified_at / comments_since_notified: anti-spam window for comment pushes (same idea as likes).
-- user_settings.notify_photo_commented: the "photoCommented" push preference (on by default).

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  media_id   TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX idx_comments_media ON comments (media_id, created_at);
CREATE INDEX idx_comments_user ON comments (user_id);

ALTER TABLE reports ADD COLUMN comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX idx_reports_comment ON reports (reporter_id, comment_id) WHERE comment_id IS NOT NULL;
DROP INDEX idx_reports_user;
CREATE UNIQUE INDEX idx_reports_user ON reports (reporter_id, target_user_id) WHERE media_id IS NULL AND comment_id IS NULL;

ALTER TABLE media ADD COLUMN comment_notified_at INTEGER;
ALTER TABLE media ADD COLUMN comments_since_notified INTEGER NOT NULL DEFAULT 0;

ALTER TABLE user_settings ADD COLUMN notify_photo_commented INTEGER NOT NULL DEFAULT 1;
