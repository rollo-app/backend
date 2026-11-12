import { type SQL, and, asc, count, isNotNull, isNull, sql } from "drizzle-orm";
import { type WaitlistRow, waitlist } from "../../db/schema";
import { orm } from "../../shared/db";
import type { WaitlistStatus } from "./waitlist.schemas";

// Reads execute and return rows; writes return an unexecuted statement (see the layers rules in CLAUDE.md).

export type WaitlistEntry = Pick<WaitlistRow, "email" | "lastSentAt" | "confirmedAt" | "unsubscribedAt">;

export async function findByEmail(db: D1Database, email: string): Promise<WaitlistEntry | null> {
  return db
    .prepare("SELECT email, last_sent_at AS lastSentAt, confirmed_at AS confirmedAt, unsubscribed_at AS unsubscribedAt FROM waitlist WHERE email = ?")
    .bind(email)
    .first<WaitlistEntry>();
}

export type NewEntry = { email: string; source: "app" | "web"; now: number; confirmHash: string; unsubscribeHash: string };

/** Inserts a new address with the confirmation just sent; no-op (0 changes) if someone inserted it first. */
export function insertEntry(db: D1Database, e: NewEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO waitlist (email, source, created_at, confirm_token_hash, unsubscribe_token_hash, last_sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(e.email, e.source, e.now, e.confirmHash, e.unsubscribeHash, e.now);
}

/**
 * Claims the right to send a (new) confirmation to a known address: rotates both tokens, clears confirmation and unsubscribe,
 * and stamps `last_sent_at`, only if it still has the `last_sent_at` the caller read (0 changes = a concurrent post won).
 */
export function restartConfirmation(db: D1Database, e: Omit<NewEntry, "source"> & { expectedLastSentAt: number | null }): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE waitlist SET confirm_token_hash = ?, unsubscribe_token_hash = ?, confirmed_at = NULL, unsubscribed_at = NULL, last_sent_at = ?
       WHERE email = ? AND last_sent_at IS ?`,
    )
    .bind(e.confirmHash, e.unsubscribeHash, e.now, e.email, e.expectedLastSentAt);
}

/** Undoes the send stamp after the email failed: a new address is removed, a known one gets its previous `last_sent_at` back. */
export function revertSend(db: D1Database, email: string, previousLastSentAt: number | null | undefined): D1PreparedStatement {
  return previousLastSentAt === undefined
    ? db.prepare("DELETE FROM waitlist WHERE email = ?").bind(email)
    : db.prepare("UPDATE waitlist SET last_sent_at = ? WHERE email = ?").bind(previousLastSentAt, email);
}

/** Confirms by token hash unless the person unsubscribed. Idempotent: keeps the first `confirmed_at`. Returns whether a live row matched. */
export async function confirmByTokenHash(db: D1Database, hash: string, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE waitlist SET confirmed_at = COALESCE(confirmed_at, ?) WHERE confirm_token_hash = ? AND unsubscribed_at IS NULL RETURNING email`,
    )
    .bind(now, hash)
    .first();
  return !!row;
}

/** Unsubscribes by token hash. Idempotent: keeps the first `unsubscribed_at`. Returns whether a row matched. */
export async function unsubscribeByTokenHash(db: D1Database, hash: string, now: number): Promise<boolean> {
  const row = await db
    .prepare(`UPDATE waitlist SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE unsubscribe_token_hash = ? RETURNING email`)
    .bind(now, hash)
    .first();
  return !!row;
}

/** Whether a token hash matches a row that the action would still apply to (confirming needs no unsubscribe). Writes nothing. */
export async function tokenIsLive(db: D1Database, action: "confirm" | "unsubscribe", hash: string): Promise<boolean> {
  const sqlText =
    action === "confirm"
      ? "SELECT 1 FROM waitlist WHERE confirm_token_hash = ? AND unsubscribed_at IS NULL"
      : "SELECT 1 FROM waitlist WHERE unsubscribe_token_hash = ?";
  return !!(await db.prepare(sqlText).bind(hash).first());
}

// ---------- Backoffice ----------

const isUnsubscribed = isNotNull(waitlist.unsubscribedAt);
const statusWhere: Record<WaitlistStatus, SQL | undefined> = {
  unsubscribed: isUnsubscribed,
  confirmed: and(isNull(waitlist.unsubscribedAt), isNotNull(waitlist.confirmedAt)),
  pending: and(isNull(waitlist.unsubscribedAt), isNull(waitlist.confirmedAt)),
};

/** Substring match on the email; `%`, `_` and `\` in `q` are literal (LIKE folds ASCII case only). */
function emailSearch(q: string | undefined): SQL | undefined {
  if (!q) return undefined;
  return sql`${waitlist.email} LIKE ${`%${q.replace(/[\\%_]/g, "\\$&")}%`} ESCAPE '\\'`;
}

const filter = (opts: { q?: string; status?: WaitlistStatus }) => and(opts.status ? statusWhere[opts.status] : undefined, emailSearch(opts.q));

export const sortable = { createdAt: waitlist.createdAt, email: waitlist.email };

export type AdminWaitlistRow = {
  email: string;
  source: "app" | "web";
  createdAt: number;
  confirmedAt: number | null;
  unsubscribedAt: number | null;
};

const adminColumns = {
  email: waitlist.email,
  source: waitlist.source,
  createdAt: waitlist.createdAt,
  confirmedAt: waitlist.confirmedAt,
  unsubscribedAt: waitlist.unsubscribedAt,
};

export async function listEntries(
  db: D1Database,
  opts: { q?: string; status?: WaitlistStatus; orderBy: SQL; limit: number; offset: number },
): Promise<AdminWaitlistRow[]> {
  return (await orm(db)
    .select(adminColumns)
    .from(waitlist)
    .where(filter(opts))
    .orderBy(opts.orderBy, asc(waitlist.email))
    .limit(opts.limit)
    .offset(opts.offset)) as AdminWaitlistRow[];
}

export async function countEntries(db: D1Database, opts: { q?: string; status?: WaitlistStatus }): Promise<number> {
  const [row] = await orm(db).select({ n: count() }).from(waitlist).where(filter(opts));
  return row?.n ?? 0;
}

/** Whole-table counts per status (not affected by search or filter). */
export async function statusTotals(db: D1Database): Promise<{ all: number; confirmed: number; pending: number; unsubscribed: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(unsubscribed_at IS NOT NULL), 0) AS unsubscribed,
         COALESCE(SUM(unsubscribed_at IS NULL AND confirmed_at IS NOT NULL), 0) AS confirmed,
         COALESCE(SUM(unsubscribed_at IS NULL AND confirmed_at IS NULL), 0) AS pending
       FROM waitlist`,
    )
    .first<{ total: number; unsubscribed: number; confirmed: number; pending: number }>();
  return { all: row?.total ?? 0, confirmed: row?.confirmed ?? 0, pending: row?.pending ?? 0, unsubscribed: row?.unsubscribed ?? 0 };
}

/** Confirmed and not unsubscribed, oldest first: the mailing list. */
export async function listConfirmed(db: D1Database): Promise<AdminWaitlistRow[]> {
  return (await orm(db)
    .select(adminColumns)
    .from(waitlist)
    .where(statusWhere.confirmed)
    .orderBy(asc(waitlist.createdAt), asc(waitlist.email))) as AdminWaitlistRow[];
}
