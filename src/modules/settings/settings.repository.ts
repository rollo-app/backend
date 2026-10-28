import { NOTIFICATION_COLUMNS, type NotificationKind, type SettingsRow } from "../../lib/settings";

// Reads execute and return rows; writes return an unexecuted statement so the service decides
// whether to `.run()` it or group it with others in `db.batch([...])`.

/** The `user_settings` rows of the given users (at most 90 ids: D1 caps bound parameters per statement at 100). */
export async function listSettingsRows(db: D1Database, userIds: string[]): Promise<SettingsRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM user_settings WHERE user_id IN (${userIds.map(() => "?").join(", ")})`)
    .bind(...userIds)
    .all<SettingsRow>();
  return results;
}

/**
 * Statement: writes only the given notification columns (atomic per column); a new row takes the defaults for the rest.
 */
export function upsertNotificationSettings(
  db: D1Database,
  userId: string,
  values: [NotificationKind, boolean][],
  now: number,
): D1PreparedStatement {
  const columns = values.map(([k]) => NOTIFICATION_COLUMNS[k]);
  return db
    .prepare(
      `INSERT INTO user_settings (user_id, ${columns.join(", ")}, updated_at) VALUES (?, ${columns.map(() => "?").join(", ")}, ?)
         ON CONFLICT (user_id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = excluded.updated_at`,
    )
    .bind(userId, ...values.map(([, on]) => (on ? 1 : 0)), now);
}

export async function findAllowFeaturing(db: D1Database, userId: string): Promise<number | null> {
  const row = await db.prepare("SELECT allow_featuring FROM user_settings WHERE user_id = ?").bind(userId).first<{ allow_featuring: number }>();
  return row ? row.allow_featuring : null;
}

/** Statement (not run): a new row takes the defaults for the rest. */
export function upsertAllowFeaturing(db: D1Database, userId: string, allowFeaturing: boolean, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO user_settings (user_id, allow_featuring, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET allow_featuring = excluded.allow_featuring, updated_at = excluded.updated_at`,
    )
    .bind(userId, allowFeaturing ? 1 : 0, now);
}
