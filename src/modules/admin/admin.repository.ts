import { type AnyColumn, type SQL, and, asc, count, desc, eq, isNull, or, sql } from "drizzle-orm";
import { type AppSetting, members, trips, users } from "../../db/schema";
import { searchText } from "../../lib/search-text";
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

/** Substring match on email, name and username; `%`, `_` and `\` in `q` are literal. SQLite `LIKE` is case-insensitive for ASCII only (no `lower()`: it would not fold accents either). */
function userSearch(q: string | undefined): SQL | undefined {
  if (!q) return undefined;
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const matches = (col: AnyColumn) => sql`${col} LIKE ${pattern} ESCAPE '\\'`;
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

export type AdminUserDetailRow = AdminUserRow & { bio: string | null; unlimitedRollos: boolean };

/** The list columns plus the editable fields only the detail needs (bio, rollo-limit exemption as a boolean). */
export async function findAdminUser(db: D1Database, id: string): Promise<AdminUserDetailRow | null> {
  const [row] = await orm(db)
    .select({ ...userColumns, bio: users.bio, unlimitedRollos: users.unlimitedRollos })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row ? { ...row, unlimitedRollos: row.unlimitedRollos !== 0 } : null;
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

/** Sets the manually assigned flags; only the given keys change. */
export function updateUserFlags(db: D1Database, userId: string, flags: { badge?: "founder" | "first_edition" | null; unlimitedRollos?: boolean }): D1PreparedStatement {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (flags.badge !== undefined) {
    sets.push("badge = ?");
    values.push(flags.badge);
  }
  if (flags.unlimitedRollos !== undefined) {
    sets.push("unlimited_rollos = ?");
    values.push(flags.unlimitedRollos ? 1 : 0);
  }
  return db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...values, userId);
}

/** Cap and active member count of a rollo (active = neither left nor removed), or null if it does not exist. */
export function findTripCapacity(db: D1Database, tripId: string): Promise<{ active: number; max: number } | null> {
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM members WHERE trip_id = t.id AND left_at IS NULL AND removed_at IS NULL) AS active, t.max_members AS max
       FROM trips t WHERE t.id = ?`,
    )
    .bind(tripId)
    .first<{ active: number; max: number }>();
}

/** Sets the cap only while it stays at or above the active member count (checked in the statement, so a concurrent join cannot slip under it). */
export function setTripMaxMembers(db: D1Database, tripId: string, maxMembers: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE trips SET max_members = ?1
       WHERE id = ?2 AND (SELECT COUNT(*) FROM members WHERE trip_id = ?2 AND left_at IS NULL AND removed_at IS NULL) <= ?1`,
    )
    .bind(maxMembers, tripId);
}

/** Statement: a superadmin keeps (or stops keeping) a rollo's originals. Nothing already purged comes back. */
export function setTripKeepOriginals(db: D1Database, tripId: string, keep: boolean): D1PreparedStatement {
  return db.prepare("UPDATE trips SET keep_originals = ? WHERE id = ?").bind(keep ? 1 : 0, tripId);
}

// Rollos. Same raw, qualified identifiers as above (correlated subqueries against `trips`).
const tripActiveMembers = sql<number>`(SELECT COUNT(*) FROM members m WHERE m.trip_id = trips.id AND m.removed_at IS NULL AND m.left_at IS NULL)`;
const tripMediaCount = sql<number>`(SELECT COUNT(*) FROM media md WHERE md.trip_id = trips.id AND md.status = 'uploaded' AND md.deleted_at IS NULL)`;

const tripColumns = {
  id: trips.id,
  name: trips.name,
  joinCode: trips.joinCode,
  createdAt: trips.createdAt,
  startsAt: trips.startsAt,
  endsAt: trips.endsAt,
  revealAt: trips.revealAt,
  revealedAt: trips.revealedAt,
  type: trips.type,
  maxMembers: trips.maxMembers,
  keepOriginals: trips.keepOriginals,
  originalsPurgedAt: trips.originalsPurgedAt,
  creatorId: users.id,
  creatorName: users.name,
  creatorUsername: users.username,
  activeMembers: tripActiveMembers,
  mediaCount: tripMediaCount,
};

export type AdminTripRow = {
  id: string;
  name: string;
  joinCode: string;
  createdAt: number;
  startsAt: number;
  endsAt: number;
  revealAt: number;
  revealedAt: number | null;
  type: "trip" | "event";
  maxMembers: number;
  keepOriginals: number;
  originalsPurgedAt: number | null;
  creatorId: string | null;
  creatorName: string | null;
  creatorUsername: string | null;
  activeMembers: number;
  mediaCount: number;
};

/** Sort keys the rollos list accepts (an allowlist: they map to SQL, so never user input). */
export const tripSortable = { createdAt: trips.createdAt, name: trips.name, activeMembers: tripActiveMembers, mediaCount: tripMediaCount };

// SQLite folds ASCII case only, so accents are replaced in SQL (rollos have no normalized name column).
const ACCENT_FOLDS = ["aáàäâãåÁÀÄÂÃÅ", "eéèëêÉÈËÊ", "iíìïîÍÌÏÎ", "oóòöôõÓÒÖÔÕ", "uúùüûÚÙÜÛ", "nñÑ", "cçÇ"];
// Literals, not bound params: 50 pairs as parameters would blow D1's 100-parameter limit.
const foldedTripName = ACCENT_FOLDS.flatMap(([to, ...from]) => from.map((ch) => [ch, to!] as const)).reduce<SQL>(
  (expr, [ch, to]) => sql`replace(${expr}, ${sql.raw(`'${ch}'`)}, ${sql.raw(`'${to}'`)})`,
  sql`${trips.name}`,
);

/**
 * Rollo name as a literal substring (ignoring case and accents) or the exact join code. Uses `instr`, not `LIKE`:
 * D1 rejects LIKE patterns over 50 bytes and `q` may be 60 characters, and `instr` needs no wildcard escaping.
 */
export function tripSearch(q: string): SQL {
  const text = searchText(q);
  return sql`(instr(lower(${foldedTripName}), ${text}) > 0 OR lower(${trips.joinCode}) = ${text})`;
}

export async function listTrips(
  db: D1Database,
  opts: { search?: SQL; orderBy: SQL; limit: number; offset: number },
): Promise<AdminTripRow[]> {
  return orm(db)
    .select(tripColumns)
    .from(trips)
    .leftJoin(users, eq(users.id, trips.createdByUserId))
    .where(opts.search)
    .orderBy(opts.orderBy, asc(trips.id))
    .limit(opts.limit)
    .offset(opts.offset);
}

export async function countTrips(db: D1Database, opts: { search?: SQL }): Promise<number> {
  const [row] = await orm(db).select({ n: count() }).from(trips).where(opts.search);
  return row?.n ?? 0;
}

export async function findAdminTrip(db: D1Database, tripId: string): Promise<AdminTripRow | null> {
  const [row] = await orm(db)
    .select(tripColumns)
    .from(trips)
    .leftJoin(users, eq(users.id, trips.createdByUserId))
    .where(eq(trips.id, tripId))
    .limit(1);
  return row ?? null;
}

export type AdminTripMemberRow = {
  id: string;
  userId: string;
  name: string | null;
  username: string | null;
  role: "admin" | "member";
  isCreator: boolean;
  joinedAt: number;
};

/** Active members: the creator first, then the other admins, then by join time. */
export async function listTripMembers(db: D1Database, tripId: string): Promise<AdminTripMemberRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.user_id AS userId, u.name, u.username, m.role,
              (m.user_id = t.created_by_user_id) AS isCreator, m.created_at AS joinedAt
       FROM members m JOIN users u ON u.id = m.user_id JOIN trips t ON t.id = m.trip_id
       WHERE m.trip_id = ? AND m.removed_at IS NULL AND m.left_at IS NULL
       ORDER BY isCreator DESC, (m.role = 'admin') DESC, m.created_at ASC, m.id ASC`,
    )
    .bind(tripId)
    .all<Omit<AdminTripMemberRow, "isCreator"> & { isCreator: number | null }>();
  return results.map((r) => ({ ...r, isCreator: r.isCreator === 1 }));
}

export type AdminEventGroupRow = { id: string; name: string; memberCount: number; mediaCount: number };

/** An event's groups in display order, with their active members and uploaded, not deleted media. */
export async function listEventGroups(db: D1Database, tripId: string): Promise<AdminEventGroupRow[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.name,
              (SELECT COUNT(*) FROM member_groups mg JOIN members m ON m.id = mg.member_id
                WHERE mg.group_id = g.id AND m.left_at IS NULL AND m.removed_at IS NULL) AS memberCount,
              (SELECT COUNT(*) FROM media_groups xg JOIN media md ON md.id = xg.media_id
                WHERE xg.group_id = g.id AND md.status = 'uploaded' AND md.deleted_at IS NULL) AS mediaCount
       FROM event_groups g WHERE g.trip_id = ? ORDER BY g.position ASC, g.id ASC`,
    )
    .bind(tripId)
    .all<AdminEventGroupRow>();
  return results;
}
