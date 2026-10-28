import { type AnyColumn, type SQL, and, asc, count, desc, eq, isNull, or, sql } from "drizzle-orm";
import { type AppSetting, members, trips, users } from "../../db/schema";
import { orm } from "../../shared/db";
import type { UserRow } from "../../types";

export type ReportRow = {
  id: string;
  reason: string;
  created_at: number;
  media_id: string | null;
  trip_id: string | null;
  rid: string;
  rname: string | null;
  runame: string | null;
  remail: string;
  tid: string;
  tname: string | null;
  tuname: string | null;
  temail: string;
};

export async function findUser(db: D1Database, userId: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
}

export async function listReports(db: D1Database, limit: number): Promise<ReportRow[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.reason, r.created_at, r.media_id, r.trip_id,
            rep.id AS rid, rep.name AS rname, rep.username AS runame, rep.email AS remail,
            tgt.id AS tid, tgt.name AS tname, tgt.username AS tuname, tgt.email AS temail
     FROM reports r JOIN users rep ON rep.id = r.reporter_id JOIN users tgt ON tgt.id = r.target_user_id
     ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<ReportRow>();
  return results;
}

export async function getSetting(db: D1Database, key: string): Promise<AppSetting | null> {
  const row = await db
    .prepare("SELECT key, value, updated_at AS updatedAt, updated_by_user_id AS updatedByUserId FROM app_settings WHERE key = ?")
    .bind(key)
    .first<AppSetting>();
  return row ?? null;
}

export function setSetting(db: D1Database, s: { key: string; value: string; updatedAt: number; updatedByUserId: string | null }): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at, updated_by_user_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`,
    )
    .bind(s.key, s.value, s.updatedAt, s.updatedByUserId);
}

export async function findUserEmail(db: D1Database, userId: string): Promise<{ id: string; email: string } | null> {
  return db.prepare("SELECT id, email FROM users WHERE id = ?").bind(userId).first<{ id: string; email: string }>();
}

// Raw, fully qualified identifiers on purpose: inside a single-table SELECT Drizzle drops the table qualifier from
// column references, which makes the correlated subqueries ambiguous ("id" of users vs members).
const lastSeenAt = sql<number | null>`(SELECT MAX(s.last_used_at) FROM sessions s WHERE s.user_id = users.id)`;
const tripCount = sql<number>`(SELECT COUNT(*) FROM members m WHERE m.user_id = users.id AND m.removed_at IS NULL AND m.left_at IS NULL)`;
const mediaCount = sql<number>`(SELECT COUNT(*) FROM media md JOIN members m ON m.id = md.member_id WHERE m.user_id = users.id AND md.status = 'uploaded' AND md.deleted_at IS NULL)`;

const userColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  username: users.username,
  appRole: users.appRole,
  badge: users.badge,
  createdAt: users.createdAt,
  lastSeenAt,
  tripCount,
  mediaCount,
};

export type AdminUserRow = {
  id: string;
  email: string;
  name: string | null;
  username: string | null;
  appRole: "user" | "superadmin";
  badge: "founder" | "first_edition" | null;
  createdAt: number;
  lastSeenAt: number | null;
  tripCount: number;
  mediaCount: number;
};

/** Sort keys the users list accepts (an allowlist: they map to SQL, so never user input). */
export const userSortable = { createdAt: users.createdAt, lastSeenAt, name: users.name, email: users.email };

/** Case-insensitive substring match on email, name and username; `%`, `_` and `\` in `q` are literal. */
function userSearch(q: string | undefined): SQL | undefined {
  if (!q) return undefined;
  const pattern = `%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
  const matches = (col: AnyColumn) => sql`lower(${col}) LIKE ${pattern} ESCAPE '\\'`;
  return or(matches(users.email), matches(users.name), matches(users.username));
}

export async function listUsers(
  db: D1Database,
  opts: { q?: string; orderBy: SQL; limit: number; offset: number },
): Promise<AdminUserRow[]> {
  return orm(db)
    .select(userColumns)
    .from(users)
    .where(userSearch(opts.q))
    .orderBy(opts.orderBy, asc(users.id))
    .limit(opts.limit)
    .offset(opts.offset);
}

export async function countUsers(db: D1Database, opts: { q?: string }): Promise<number> {
  const [row] = await orm(db).select({ n: count() }).from(users).where(userSearch(opts.q));
  return row?.n ?? 0;
}

export async function findAdminUser(db: D1Database, id: string): Promise<AdminUserRow | null> {
  const [row] = await orm(db).select(userColumns).from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export type UserTripRow = {
  id: string;
  name: string;
  role: "admin" | "member";
  startsAt: number;
  endsAt: number;
  revealAt: number;
  revealedAt: number | null;
};

/** Active memberships of a user (not removed, not left), newest rollo first. */
export async function listUserTrips(db: D1Database, userId: string): Promise<UserTripRow[]> {
  return orm(db)
    .select({
      id: trips.id,
      name: trips.name,
      role: members.role,
      startsAt: trips.startsAt,
      endsAt: trips.endsAt,
      revealAt: trips.revealAt,
      revealedAt: trips.revealedAt,
    })
    .from(members)
    .innerJoin(trips, eq(trips.id, members.tripId))
    .where(and(eq(members.userId, userId), isNull(members.removedAt), isNull(members.leftAt)))
    .orderBy(desc(trips.startsAt), asc(trips.id));
}
