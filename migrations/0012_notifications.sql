-- Push notifications, user settings and likes.
-- push_tokens: Expo push tokens; a token belongs to one user at a time (same phone, another account → it moves).
-- user_settings: one column per preference, 1 = on. No row means every default.
-- likes: one per user and photo. media.like_notified_at / likes_since_notified: anti-spam window for like pushes.
-- trips.started_notified_at / revealed_notified_at: the "started" and "revealed" pushes were already sent.

CREATE TABLE push_tokens (
  token        TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX idx_push_tokens_user ON push_tokens (user_id);

CREATE TABLE user_settings (
  user_id               TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notify_added_to_trip  INTEGER NOT NULL DEFAULT 1,
  notify_new_friend     INTEGER NOT NULL DEFAULT 1,
  notify_trip_started   INTEGER NOT NULL DEFAULT 1,
  notify_trip_revealed  INTEGER NOT NULL DEFAULT 1,
  notify_photo_featured INTEGER NOT NULL DEFAULT 1,
  notify_photo_liked    INTEGER NOT NULL DEFAULT 1,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE likes (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id   TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_id)
);

CREATE INDEX idx_likes_media ON likes (media_id);

ALTER TABLE media ADD COLUMN like_notified_at INTEGER;
ALTER TABLE media ADD COLUMN likes_since_notified INTEGER NOT NULL DEFAULT 0;

ALTER TABLE trips ADD COLUMN started_notified_at INTEGER;
ALTER TABLE trips ADD COLUMN revealed_notified_at INTEGER;

-- Trips that already started or revealed before this deploy do not notify.
UPDATE trips SET started_notified_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE started_notified_at IS NULL AND starts_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000;
UPDATE trips SET revealed_notified_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE revealed_notified_at IS NULL AND (revealed_at IS NOT NULL OR reveal_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000);
