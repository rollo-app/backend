-- Friends: symmetric friendships, one-hour friend links, claim tokens and rate-limit attempts.
-- `left_at` (the member left on their own) is distinct from `removed_at` (the admin removed them).

CREATE TABLE friendships (
  user_a     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);

CREATE INDEX idx_friendships_b ON friendships (user_b);

CREATE TABLE friend_links (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL UNIQUE,                 -- SHA-256 of the code; the code itself is never stored
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_friend_links_user ON friend_links (user_id);

CREATE TABLE friend_claims (
  id           TEXT PRIMARY KEY,
  link_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- who generated the link
  claim_hash   TEXT NOT NULL UNIQUE,               -- SHA-256 of the claim token
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE friend_attempts (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL,                        -- "user:<id>" or "ip:<ip>"
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_friend_attempts_key ON friend_attempts (key, created_at);

ALTER TABLE members ADD COLUMN left_at INTEGER;
ALTER TABLE members ADD COLUMN added_by_user_id TEXT;
