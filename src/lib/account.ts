import type { Deps } from "../container";
import type { ObjectStorage } from "../ports/storage";
import type { MediaRow, Role, UserRow } from "../types";

async function deleteMediaRows(db: D1Database, storage: ObjectStorage, where: string, id: string) {
  const { results } = await db
    .prepare(`SELECT original_key, thumb_key FROM media WHERE ${where} = ?`)
    .bind(id)
    .all<Pick<MediaRow, "original_key" | "thumb_key">>();
  const keys = results.flatMap((r) => [r.original_key, r.thumb_key]);
  await storage.delete(keys);
}

/**
 * Permanently deletes an account: its media and memberships (handing the admin role on, or deleting emptied trips),
 * friendships, friend links, reports and blocks on both sides, push tokens, settings, likes, avatar, sessions and login codes.
 */
export async function deleteAccount(deps: Pick<Deps, "db" | "storage">, user: UserRow): Promise<void> {
  const { db: DB, storage } = deps;

  const { results: memberships } = await DB.prepare("SELECT * FROM members WHERE user_id = ?")
    .bind(user.id)
    .all<{ id: string; trip_id: string; role: Role; removed_at: number | null; left_at: number | null }>();

  for (const m of memberships) {
    await deleteMediaRows(DB, storage, "member_id", m.id);
    await DB.batch([
      DB.prepare("DELETE FROM media WHERE member_id = ?").bind(m.id),
      DB.prepare("DELETE FROM members WHERE id = ?").bind(m.id),
    ]);

    const next = await DB.prepare(
      "SELECT id, role FROM members WHERE trip_id = ? AND removed_at IS NULL AND left_at IS NULL ORDER BY created_at, id",
    )
      .bind(m.trip_id)
      .all<{ id: string; role: Role }>();

    if (next.results.length === 0) {
      await deleteMediaRows(DB, storage, "trip_id", m.trip_id);
      await DB.batch([
        DB.prepare("DELETE FROM media WHERE trip_id = ?").bind(m.trip_id),
        DB.prepare("DELETE FROM members WHERE trip_id = ?").bind(m.trip_id),
        DB.prepare("DELETE FROM trips WHERE id = ?").bind(m.trip_id),
      ]);
    } else if (m.role === "admin" && m.removed_at === null && m.left_at === null && !next.results.some((r) => r.role === "admin")) {
      await DB.prepare("UPDATE members SET role = 'admin' WHERE id = ?").bind(next.results[0]!.id).run();
    }
  }

  const avatars = [user.avatar_key, user.pending_avatar_key].filter((k): k is string => k !== null);
  if (avatars.length) await storage.delete(avatars);

  await DB.batch([
    DB.prepare("DELETE FROM push_tokens WHERE user_id = ?").bind(user.id),
    DB.prepare("DELETE FROM user_settings WHERE user_id = ?").bind(user.id),
    DB.prepare("DELETE FROM likes WHERE user_id = ?").bind(user.id),
    DB.prepare("DELETE FROM friendships WHERE user_a = ? OR user_b = ?").bind(user.id, user.id),
    DB.prepare("DELETE FROM reports WHERE reporter_id = ? OR target_user_id = ?").bind(user.id, user.id),
    DB.prepare("DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?").bind(user.id, user.id),
    DB.prepare("DELETE FROM friend_links WHERE user_id = ?").bind(user.id),
    DB.prepare("DELETE FROM friend_claims WHERE link_user_id = ?").bind(user.id),
    DB.prepare("DELETE FROM friend_attempts WHERE key = ?").bind(`user:${user.id}`),
    DB.prepare("UPDATE members SET added_by_user_id = NULL WHERE added_by_user_id = ?").bind(user.id),
    DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    DB.prepare("DELETE FROM auth_codes WHERE email = ?").bind(user.email),
    DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);
}
