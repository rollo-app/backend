-- User accounts (email + code). Replaces the per-trip token model.
-- Nothing was deployed yet, so `members` and `media` are dropped and recreated without migrating data.

CREATE TABLE users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name               TEXT,                         -- null until the profile is completed
  avatar_key         TEXT,                         -- R2 key of the current avatar
  pending_avatar_key TEXT,                         -- key handed out for an upload not yet confirmed
  created_at         INTEGER NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,               -- SHA-256 of the token; the token itself is never stored
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE auth_codes (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL COLLATE NOCASE,
  code_hash  TEXT NOT NULL,                        -- SHA-256 of `${email}:${code}`
  ip         TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER                               -- set when consumed or superseded by a newer code
);

CREATE INDEX idx_auth_codes_email ON auth_codes (email, created_at);
CREATE INDEX idx_auth_codes_ip ON auth_codes (ip, created_at);

DROP TABLE media;
DROP TABLE members;

CREATE TABLE members (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at INTEGER NOT NULL,
  removed_at INTEGER,
  UNIQUE (trip_id, user_id)
);

CREATE INDEX idx_members_user ON members (user_id);

CREATE TABLE media (
  id            TEXT PRIMARY KEY,               -- UUID generated on the phone (offline idempotency)
  trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  member_id     TEXT NOT NULL REFERENCES members(id),
  type          TEXT NOT NULL CHECK (type IN ('photo', 'video')),
  taken_at      INTEGER NOT NULL,
  local_date    TEXT NOT NULL,
  lat           REAL,
  lng           REAL,
  accuracy_m    REAL,
  caption       TEXT,
  duration_s    REAL,
  width         INTEGER,
  height        INTEGER,
  size_bytes    INTEGER,
  original_key  TEXT NOT NULL,
  thumb_key     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded')),
  created_at    INTEGER NOT NULL,
  uploaded_at   INTEGER,
  thumbhash     TEXT,
  deleted_at    INTEGER
);

CREATE INDEX idx_media_trip_time  ON media (trip_id, taken_at);
CREATE INDEX idx_media_member_day ON media (member_id, local_date, type);
