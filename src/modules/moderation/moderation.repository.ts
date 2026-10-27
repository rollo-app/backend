// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

export type PendingReport = { id: string; reporter_id: string; media_id: string | null; target_user_id: string; reason: string };
export type PendingBlock = { blocker_id: string; blocked_id: string };

/** How many reports (or blocks) the user made since `since`. */
export async function countActionsSince(db: D1Database, table: "reports" | "blocks", userId: string, since: number): Promise<number> {
  const column = table === "reports" ? "reporter_id" : "blocker_id";
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ? AND created_at > ?`)
    .bind(userId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** How many reports plus blocks the user made since `since`. */
export async function countReportsAndBlocksSince(db: D1Database, userId: string, since: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM reports WHERE reporter_id = ?1 AND created_at > ?2) +
              (SELECT COUNT(*) FROM blocks WHERE blocker_id = ?1 AND created_at > ?2) AS n`,
    )
    .bind(userId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export function listUnemailedReports(db: D1Database, before: number) {
  return db
    .prepare("SELECT id, reporter_id, media_id, target_user_id, reason FROM reports WHERE unemailed = 1 AND created_at < ? ORDER BY created_at LIMIT 500")
    .bind(before)
    .all<PendingReport>();
}

export function listUnemailedBlocks(db: D1Database, before: number) {
  return db
    .prepare("SELECT blocker_id, blocked_id FROM blocks WHERE unemailed = 1 AND created_at < ? ORDER BY created_at LIMIT 500")
    .bind(before)
    .all<PendingBlock>();
}

/** Claims the day's summary: true only for the caller that inserted the counter. */
export async function claimSummaryDay(db: D1Database, day: string): Promise<boolean> {
  const claim = await db.prepare("INSERT OR IGNORE INTO email_counters (kind, day, count) VALUES ('summary', ?, 1)").bind(day).run();
  return claim.meta.changes > 0;
}

export function releaseSummaryDay(db: D1Database, day: string): Promise<D1Result> {
  return db.prepare("DELETE FROM email_counters WHERE kind = 'summary' AND day = ?").bind(day).run();
}

export function markReportEmailed(db: D1Database, reportId: string): D1PreparedStatement {
  return db.prepare("UPDATE reports SET unemailed = 0 WHERE id = ?").bind(reportId);
}

export function markBlockEmailed(db: D1Database, blockerId: string, blockedId: string): D1PreparedStatement {
  return db.prepare("UPDATE blocks SET unemailed = 0 WHERE blocker_id = ? AND blocked_id = ?").bind(blockerId, blockedId);
}
