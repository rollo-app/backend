-- Per-member archive of a rollo: hidden from "Tus rollos" for that member only. NULL = not archived.
ALTER TABLE members ADD COLUMN archived_at INTEGER;

-- Tombstones of deleted rollos (the rows are gone; this keeps the deletion and drives cleanup).
CREATE TABLE deleted_trips (
  trip_id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);

-- R2 keys pending purge after a rollo is deleted.
CREATE TABLE r2_purge (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Complete the creator of every rollo (same SQL as BACKFILL_CREATOR_SQL in src/lib/creator.ts, unscoped).
-- No active admin: the oldest active member becomes admin.
UPDATE members SET role = 'admin' WHERE id = (
  SELECT m.id FROM members m WHERE m.trip_id = members.trip_id AND m.removed_at IS NULL AND m.left_at IS NULL ORDER BY m.created_at, m.id LIMIT 1
) AND EXISTS (
  SELECT 1 FROM trips WHERE trips.id = members.trip_id AND trips.created_by_user_id IS NULL
) AND NOT EXISTS (
  SELECT 1 FROM members m WHERE m.trip_id = members.trip_id AND m.role = 'admin' AND m.removed_at IS NULL AND m.left_at IS NULL
);
UPDATE trips SET created_by_user_id = (
  SELECT m.user_id FROM members m WHERE m.trip_id = trips.id AND m.role = 'admin' AND m.removed_at IS NULL AND m.left_at IS NULL ORDER BY m.created_at, m.id LIMIT 1
) WHERE created_by_user_id IS NULL;
