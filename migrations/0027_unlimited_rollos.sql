-- Exempts a user from the limits on creating rollos. Set by hand with SQL (no endpoint sets it). 0 = limited.
ALTER TABLE users ADD COLUMN unlimited_rollos INTEGER NOT NULL DEFAULT 0;

-- Who created the rollo (the admin role can move, e.g. when an account is deleted). NULL for rows nobody can attribute.
ALTER TABLE trips ADD COLUMN created_by_user_id TEXT;
UPDATE trips SET created_by_user_id = (
  SELECT m.user_id FROM members m WHERE m.trip_id = trips.id AND m.role = 'admin' ORDER BY m.created_at LIMIT 1
);
