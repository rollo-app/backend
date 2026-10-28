import type { MediaRow, Role } from "../../types";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type AccountMembership = { id: string; trip_id: string; role: Role; removed_at: number | null; left_at: number | null };
type MediaKeys = Pick<MediaRow, "original_key" | "thumb_key">;

export async function listMemberships(db: D1Database, userId: string): Promise<AccountMembership[]> {
  const { results } = await db.prepare("SELECT * FROM members WHERE user_id = ?").bind(userId).all<AccountMembership>();
  return results;
}

/** R2 keys (original and thumb) of the media of a member. */
export async function listMemberMediaKeys(db: D1Database, memberId: string): Promise<MediaKeys[]> {
  const { results } = await db.prepare("SELECT original_key, thumb_key FROM media WHERE member_id = ?").bind(memberId).all<MediaKeys>();
  return results;
}

/** R2 keys (original and thumb) of every media of a trip. */
export async function listTripMediaKeys(db: D1Database, tripId: string): Promise<MediaKeys[]> {
  const { results } = await db.prepare("SELECT original_key, thumb_key FROM media WHERE trip_id = ?").bind(tripId).all<MediaKeys>();
  return results;
}

export function deleteMemberMedia(db: D1Database, memberId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM media WHERE member_id = ?").bind(memberId);
}

export function deleteMember(db: D1Database, memberId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM members WHERE id = ?").bind(memberId);
}

/** Active members of a trip, oldest first. */
export async function listActiveTripMembers(db: D1Database, tripId: string): Promise<{ id: string; role: Role }[]> {
  const { results } = await db
    .prepare("SELECT id, role FROM members WHERE trip_id = ? AND removed_at IS NULL AND left_at IS NULL ORDER BY created_at, id")
    .bind(tripId)
    .all<{ id: string; role: Role }>();
  return results;
}

export function deleteTripMedia(db: D1Database, tripId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM media WHERE trip_id = ?").bind(tripId);
}

export function deleteTripMembers(db: D1Database, tripId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM members WHERE trip_id = ?").bind(tripId);
}

export function deleteTrip(db: D1Database, tripId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM trips WHERE id = ?").bind(tripId);
}

export function promoteToAdmin(db: D1Database, memberId: string): D1PreparedStatement {
  return db.prepare("UPDATE members SET role = 'admin' WHERE id = ?").bind(memberId);
}

/** Everything that hangs off the user row, in the order it must go (the user row last). */
export function deleteUserData(db: D1Database, user: { id: string; email: string }): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM push_tokens WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM user_settings WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM likes WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM comments WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM friendships WHERE user_a = ? OR user_b = ?").bind(user.id, user.id),
    db.prepare("DELETE FROM friend_requests WHERE from_user_id = ? OR to_user_id = ?").bind(user.id, user.id),
    db.prepare("DELETE FROM reports WHERE reporter_id = ? OR target_user_id = ?").bind(user.id, user.id),
    db.prepare("DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?").bind(user.id, user.id),
    db.prepare("DELETE FROM friend_links WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM friend_claims WHERE link_user_id = ?").bind(user.id),
    db.prepare("DELETE FROM friend_attempts WHERE key = ?").bind(`user:${user.id}`),
    db.prepare("UPDATE members SET added_by_user_id = NULL WHERE added_by_user_id = ?").bind(user.id),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM auth_codes WHERE email = ?").bind(user.email),
    db.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ];
}
