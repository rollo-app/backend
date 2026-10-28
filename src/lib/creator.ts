/**
 * Backfill of `trips.created_by_user_id` for rollos nobody can be attributed to (NULL).
 * Creator = oldest active admin; with none, the oldest active member, who is promoted to admin.
 * "Active" = removed_at IS NULL AND left_at IS NULL; "oldest" = ORDER BY created_at, id.
 *
 * Statements run in order. Both take `?1` = trip id to scope to one rollo, or NULL for all of them.
 * migrations/0029_rollo_roles_archive_delete.sql duplicates them unscoped.
 */
const ACTIVE = "m.removed_at IS NULL AND m.left_at IS NULL";
const NEEDS_CREATOR = "trips.created_by_user_id IS NULL AND (?1 IS NULL OR trips.id = ?1)";

export const BACKFILL_CREATOR_SQL: readonly string[] = [
  // 1) No active admin: the oldest active member becomes admin.
  `UPDATE members SET role = 'admin' WHERE id = (
    SELECT m.id FROM members m WHERE m.trip_id = members.trip_id AND ${ACTIVE} ORDER BY m.created_at, m.id LIMIT 1
  ) AND EXISTS (
    SELECT 1 FROM trips WHERE trips.id = members.trip_id AND ${NEEDS_CREATOR}
  ) AND NOT EXISTS (
    SELECT 1 FROM members m WHERE m.trip_id = members.trip_id AND m.role = 'admin' AND ${ACTIVE}
  )`,
  // 2) The creator is the oldest active admin.
  `UPDATE trips SET created_by_user_id = (
    SELECT m.user_id FROM members m WHERE m.trip_id = trips.id AND m.role = 'admin' AND ${ACTIVE} ORDER BY m.created_at, m.id LIMIT 1
  ) WHERE ${NEEDS_CREATOR}`,
];
