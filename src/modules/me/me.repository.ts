import { hiddenMediaSql } from "../reports/reports.repository";
import type { Role, TripRow } from "../../types";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type MyTripRow = TripRow & { my_role: Role; my_archived_at: number | null; total_uploaded: number; cover_thumbhash: string | null };

export type ProfileFields = { name: string | null; username: string | null; bio: string | null; profile_visibility: "friends" | "public" };

export function updateProfile(db: D1Database, userId: string, next: ProfileFields): D1PreparedStatement {
  return db
    .prepare("UPDATE users SET name = ?, username = ?, bio = ?, profile_visibility = ? WHERE id = ?")
    .bind(next.name, next.username, next.bio, next.profile_visibility, userId);
}

export function setPendingAvatarKey(db: D1Database, userId: string, key: string): D1PreparedStatement {
  return db.prepare("UPDATE users SET pending_avatar_key = ? WHERE id = ?").bind(key, userId);
}

export function clearPendingAvatarKey(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare("UPDATE users SET pending_avatar_key = NULL WHERE id = ?").bind(userId);
}

export function promoteAvatar(db: D1Database, userId: string, key: string): D1PreparedStatement {
  return db.prepare("UPDATE users SET avatar_key = ?, pending_avatar_key = NULL WHERE id = ?").bind(key, userId);
}

export async function listMyTrips(db: D1Database, userId: string): Promise<MyTripRow[]> {
  const { results } = await db
    .prepare(
      `SELECT t.*, m.role AS my_role, m.archived_at AS my_archived_at,
            (SELECT COUNT(*) FROM media WHERE trip_id = t.id AND status = 'uploaded' AND deleted_at IS NULL AND paired_media_id IS NULL
               AND (archived_at IS NULL OR member_id = m.id)) AS total_uploaded,
            (SELECT cm.thumbhash FROM media cm JOIN members cmem ON cmem.id = cm.member_id
             WHERE cm.trip_id = t.id AND cm.status = 'uploaded' AND cm.deleted_at IS NULL AND cm.paired_media_id IS NULL AND cm.thumbhash IS NOT NULL
               AND (cm.archived_at IS NULL OR cm.member_id = m.id) AND ${hiddenMediaSql("cm", "cmem")}
             ORDER BY cm.taken_at DESC, cm.id DESC LIMIT 1) AS cover_thumbhash
     FROM members m JOIN trips t ON t.id = m.trip_id
     WHERE m.user_id = ? AND m.removed_at IS NULL AND m.left_at IS NULL
     ORDER BY t.starts_at DESC`,
    )
    .bind(userId, userId, userId)
    .all<MyTripRow>();
  return results;
}

export function upsertPushToken(db: D1Database, token: string, userId: string, sessionId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO push_tokens (token, user_id, session_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (token) DO UPDATE SET
       created_at = CASE WHEN push_tokens.user_id = excluded.user_id THEN push_tokens.created_at ELSE excluded.created_at END,
       user_id = excluded.user_id,
       session_id = excluded.session_id,
       last_seen_at = excluded.last_seen_at`,
    )
    .bind(token, userId, sessionId, now, now);
}

export function deletePushToken(db: D1Database, token: string, userId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM push_tokens WHERE token = ? AND user_id = ?").bind(token, userId);
}
