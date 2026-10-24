export function findOtherUserWithUsername(db: D1Database, username: string, userId: string): Promise<{ id: string } | null> {
  return db.prepare("SELECT id FROM users WHERE username = ? AND id != ?").bind(username, userId).first<{ id: string }>();
}
