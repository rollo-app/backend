import type { AppSetting } from "../../db/schema";
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
