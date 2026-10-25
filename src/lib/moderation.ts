import { and, isNotNull, eq, notInArray, type SQL } from "drizzle-orm";
import { QueryBuilder, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import { blocks, reports } from "../db/schema";
import { MODERATION_ACTIONS_PER_DAY, reserveEmailSlot, SUPPORT_EMAILS_PER_DAY, SUPPORT_EMAILS_PER_USER_PER_DAY } from "./email-caps";

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

/**
 * Drizzle version of `hiddenMediaSql`: a condition to AND into a query that hides media the viewer reported and
 * media whose author the viewer blocked. Pass the media id column and the author's user id column (`members.userId`)
 * of the query being built. Same semantics as the string version; no binds to order by hand.
 */
export function notHiddenFor(viewerId: string, mediaId: SQLiteColumn, authorUserId: SQLiteColumn): SQL {
  const qb = new QueryBuilder();
  const reportedByViewer = qb
    .select({ mediaId: reports.mediaId })
    .from(reports)
    .where(and(eq(reports.reporterId, viewerId), isNotNull(reports.mediaId)));
  const blockedByViewer = qb.select({ blockedId: blocks.blockedId }).from(blocks).where(eq(blocks.blockerId, viewerId));
  return and(notInArray(mediaId, reportedByViewer), notInArray(authorUserId, blockedByViewer))!;
}

/** Whether the user already made the maximum of reports (or blocks) in the last 24 hours. */
export async function atModerationActionCap(db: D1Database, table: "reports" | "blocks", userId: string): Promise<boolean> {
  const column = table === "reports" ? "reporter_id" : "blocker_id";
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ? AND created_at > ?`)
    .bind(userId, Date.now() - 24 * 60 * 60 * 1000)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= MODERATION_ACTIONS_PER_DAY;
}

export const MODERATION_ACTION_CAP_MESSAGE = "Hiciste muchas denuncias o bloqueos hoy. Probá mañana.";

/**
 * Whether a moderation email may be sent for this user. Call after inserting the new report/block row,
 * so the count includes it: the 3rd is still emailed, the 4th is not. Also takes a slot of the global daily support cap
 * (`SUPPORT_EMAILS_PER_DAY`), so call it only when an email will actually be sent.
 */
export async function withinModerationEmailCap(db: D1Database, userId: string): Promise<boolean> {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM reports WHERE reporter_id = ?1 AND created_at > ?2) +
              (SELECT COUNT(*) FROM blocks WHERE blocker_id = ?1 AND created_at > ?2) AS n`,
    )
    .bind(userId, since)
    .first<{ n: number }>();
  return (row?.n ?? 0) <= SUPPORT_EMAILS_PER_USER_PER_DAY && (await reserveEmailSlot(db, "support", SUPPORT_EMAILS_PER_DAY));
}
