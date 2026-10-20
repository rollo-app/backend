-- Unique username (Instagram style). Stored lowercase without "@".
-- Nullable because existing accounts don't have one yet; the API requires it to join or create a trip.
ALTER TABLE users ADD COLUMN username TEXT;

CREATE UNIQUE INDEX idx_users_username ON users (username);
