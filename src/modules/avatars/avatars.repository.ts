export async function findAvatarKey(db: D1Database, userId: string): Promise<string | null | undefined> {
  const row = await db.prepare("SELECT avatar_key FROM users WHERE id = ?").bind(userId).first<{ avatar_key: string | null }>();
  return row ? row.avatar_key : undefined;
}
