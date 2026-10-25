-- Friend requests sent from another person's profile. The friendship exists only once the receiver accepts
-- (friend links still make friends at once). rejected_at is set when the receiver rejects: silent, the sender keeps
-- seeing "sent" and can resend only 30 days later. cancelled_at is a tombstone for a request the sender took back:
-- the row stays so cancelling and resending cannot dodge the daily cap, the 30 days or a repeated notification.
CREATE TABLE friend_requests (
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  rejected_at  INTEGER,
  cancelled_at INTEGER,
  PRIMARY KEY (from_user_id, to_user_id)
);

CREATE INDEX idx_friend_requests_to ON friend_requests (to_user_id);
CREATE INDEX idx_friend_requests_from_time ON friend_requests (from_user_id, created_at);

ALTER TABLE user_settings ADD COLUMN notify_friend_request INTEGER NOT NULL DEFAULT 1;
