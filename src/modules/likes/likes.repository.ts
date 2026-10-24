import { hiddenMediaSql } from "../../lib/moderation";
import type { MediaRow, TripRow, UserRow } from "../../types";
// A repository importing another module's SQL fragments is OK for now: the likes visibility rules mirror the featured ones.
import { VISIBLE_FROM, VISIBLE_WHERE } from "../featured/featured.repository";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type LikeableRow = Pick<MediaRow, "id" | "type" | "trip_id"> &
  Pick<TripRow, "revealed_at" | "reveal_at"> & { author_user_id: string; is_member: number };

/** The live uploaded media the viewer hasn't hidden (reported or blocked author), with whether they are an active member of its rollo. */
export function findLikeableRow(db: D1Database, viewerId: string, mediaId: string): Promise<LikeableRow | null> {
  return db
    .prepare(
      `SELECT m.id, m.type, m.trip_id, author.user_id AS author_user_id, t.revealed_at, t.reveal_at,
              EXISTS (SELECT 1 FROM members me WHERE me.trip_id = m.trip_id AND me.user_id = ?
                        AND me.removed_at IS NULL AND me.left_at IS NULL) AS is_member
       FROM media m JOIN trips t ON t.id = m.trip_id JOIN members author ON author.id = m.member_id
       WHERE m.id = ? AND m.status = 'uploaded' AND m.deleted_at IS NULL AND ${hiddenMediaSql("m", "author")}`,
    )
    .bind(viewerId, mediaId, viewerId, viewerId)
    .first<LikeableRow>();
}

/** The profiles where the photo shows as featured right now (only photos ever do). */
export async function listFeaturedOwners(db: D1Database, mediaId: string, now: number): Promise<Pick<UserRow, "id" | "profile_visibility">[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT u.id, u.profile_visibility FROM ${VISIBLE_FROM} JOIN users u ON u.id = f.user_id
       WHERE ${VISIBLE_WHERE} AND f.media_id = ?`,
    )
    .bind(now, mediaId)
    .all<Pick<UserRow, "id" | "profile_visibility">>();
  return results;
}

export function insertLike(db: D1Database, userId: string, mediaId: string, now: number): D1PreparedStatement {
  return db.prepare("INSERT OR IGNORE INTO likes (user_id, media_id, created_at) VALUES (?, ?, ?)").bind(userId, mediaId, now);
}

export function deleteLike(db: D1Database, userId: string, mediaId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM likes WHERE user_id = ? AND media_id = ?").bind(userId, mediaId);
}
