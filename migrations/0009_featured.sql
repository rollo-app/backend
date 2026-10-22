-- Featured photos: photos from revealed rollos that a user pins to their profile.
-- Profile visibility: who can see your featured photos and bio ('friends' or 'public').
-- media.feature_blocked_at: the author does not let others feature this photo (null = allowed).

CREATE TABLE featured (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id   TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_id)
);

CREATE INDEX idx_featured_user ON featured (user_id, created_at);

ALTER TABLE users ADD COLUMN profile_visibility TEXT NOT NULL DEFAULT 'friends';
ALTER TABLE media ADD COLUMN feature_blocked_at INTEGER;
