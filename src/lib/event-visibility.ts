import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Who sees a photo of an event: only the guests who share a group with it (`media_groups` x `member_groups`); the
 * organizers (active admins of the event) see everything. In a regular trip (`trips.type = 'trip'`) everyone sees everything.
 * Every read path that shows a trip member a photo ANDs this in, so the rule lives here and nowhere else.
 */

/** Binds `mediaVisibleToSql` consumes when `viewerExpr` is a `?`: the viewer id, three times. */
export const MEDIA_VISIBLE_BINDS = 3;

/**
 * Raw SQL version, for the repositories that write their queries by hand. `viewerExpr`, `mediaExpr` and `tripExpr` are SQL
 * expressions (e.g. `v.viewer_id`, `m.id`, `m.trip_id`). A `?` as `viewerExpr` takes `MEDIA_VISIBLE_BINDS` binds, each the viewer's user id.
 */
export function mediaVisibleToSql(viewerExpr: string, mediaExpr: string, tripExpr: string): string {
  return (
    `((SELECT vt.type FROM trips vt WHERE vt.id = ${tripExpr}) = 'trip'` +
    ` OR EXISTS (SELECT 1 FROM members va WHERE va.trip_id = ${tripExpr} AND va.user_id = ${viewerExpr} AND va.role = 'admin'` +
    ` AND va.removed_at IS NULL AND va.left_at IS NULL)` +
    ` OR EXISTS (SELECT 1 FROM media vam JOIN members vau ON vau.id = vam.member_id WHERE vam.id = ${mediaExpr} AND vau.user_id = ${viewerExpr}` +
    ` AND vau.trip_id = ${tripExpr} AND vau.removed_at IS NULL AND vau.left_at IS NULL)` +
    ` OR EXISTS (SELECT 1 FROM media_groups vmg JOIN member_groups vgm ON vgm.group_id = vmg.group_id` +
    ` JOIN members vm ON vm.id = vgm.member_id` +
    ` WHERE vmg.media_id = ${mediaExpr} AND vm.trip_id = ${tripExpr} AND vm.user_id = ${viewerExpr}` +
    ` AND vm.removed_at IS NULL AND vm.left_at IS NULL))`
  );
}

/** Drizzle version of `mediaVisibleToSql`: a condition to AND into a query over `media` (pass its id and trip id columns). */
export function mediaVisibleTo(viewerUserId: string, mediaId: SQLWrapper, tripId: SQLWrapper): SQL {
  return sql`((SELECT vt.type FROM trips vt WHERE vt.id = ${tripId}) = 'trip'
    OR EXISTS (SELECT 1 FROM members va WHERE va.trip_id = ${tripId} AND va.user_id = ${viewerUserId} AND va.role = 'admin'
               AND va.removed_at IS NULL AND va.left_at IS NULL)
    OR EXISTS (SELECT 1 FROM media vam JOIN members vau ON vau.id = vam.member_id WHERE vam.id = ${mediaId} AND vau.user_id = ${viewerUserId}
               AND vau.trip_id = ${tripId} AND vau.removed_at IS NULL AND vau.left_at IS NULL)
    OR EXISTS (SELECT 1 FROM media_groups vmg JOIN member_groups vgm ON vgm.group_id = vmg.group_id
               JOIN members vm ON vm.id = vgm.member_id
               WHERE vmg.media_id = ${mediaId} AND vm.trip_id = ${tripId} AND vm.user_id = ${viewerUserId}
                 AND vm.removed_at IS NULL AND vm.left_at IS NULL))`;
}

/** One-off check for services that already hold the media and trip ids. */
export async function canSeeMediaInTrip(db: D1Database, viewerUserId: string, mediaId: string, tripId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT ${mediaVisibleToSql("?1", "?2", "?3")} AS visible`)
    .bind(viewerUserId, mediaId, tripId)
    .first<{ visible: number }>();
  return row?.visible === 1;
}

/** Whether a push about the photo may go to its author: still an active member of the trip (any type) and sees the photo. */
export async function canNotifyAuthor(db: D1Database, authorUserId: string, mediaId: string, tripId: string): Promise<boolean> {
  const member = await db
    .prepare("SELECT 1 FROM members WHERE trip_id = ? AND user_id = ? AND removed_at IS NULL AND left_at IS NULL")
    .bind(tripId, authorUserId)
    .first();
  return member !== null && (await canSeeMediaInTrip(db, authorUserId, mediaId, tripId));
}
