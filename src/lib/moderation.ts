/** Whether either of the two users has blocked the other. */
export async function isBlockedEitherWay(db: D1Database, a: string, b: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM blocks WHERE (blocker_id = ?1 AND blocked_id = ?2) OR (blocker_id = ?2 AND blocked_id = ?1)")
    .bind(a, b)
    .first();
  return row !== null;
}

/** Ids of the users the viewer has blocked. */
export async function blockedIdsFor(db: D1Database, viewerId: string): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT blocked_id FROM blocks WHERE blocker_id = ?").bind(viewerId).all<{ blocked_id: string }>();
  return new Set(results.map((r) => r.blocked_id));
}

/**
 * SQL boolean fragment to AND into a WHERE clause: hides media the viewer reported and media whose author the viewer blocked.
 * `mediaAlias` is the alias of `media`, `authorMemberAlias` the alias of the author's `members` row.
 * Consumes exactly two binds, in this order, both the viewer's user id: (1) reports, (2) blocks.
 */
export function hiddenMediaSql(mediaAlias: string, authorMemberAlias: string): string {
  return (
    `(${mediaAlias}.id NOT IN (SELECT media_id FROM reports WHERE reporter_id = ? AND media_id IS NOT NULL)` +
    ` AND ${authorMemberAlias}.user_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?))`
  );
}
