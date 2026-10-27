import { NOTIFICATION_KINDS, notificationSettingsFromRow, type NotificationSettings, type SettingsRow } from "../../lib/settings";
import * as repo from "./settings.repository";

export type PrivacySettings = { allowFeaturing: boolean };

// D1 caps bound parameters per statement at 100.
const CHUNK = 90;

/** Notification settings for each user id (defaults for users without a row). */
export async function getNotificationSettings(db: D1Database, userIds: string[]): Promise<Map<string, NotificationSettings>> {
  const ids = [...new Set(userIds)];
  const rows = new Map<string, SettingsRow>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    for (const r of await repo.listSettingsRows(db, ids.slice(i, i + CHUNK))) rows.set(r.user_id, r);
  }
  return new Map(ids.map((id) => [id, notificationSettingsFromRow(rows.get(id))]));
}

/** Applies a partial update and returns the resulting settings. Keys left out keep their value (or the default). */
export async function updateNotificationSettings(
  db: D1Database,
  userId: string,
  patch: Partial<NotificationSettings>,
): Promise<NotificationSettings> {
  const values = NOTIFICATION_KINDS.filter((k) => patch[k] !== undefined).map((k): [typeof k, boolean] => [k, patch[k]!]);
  if (values.length > 0) await repo.upsertNotificationSettings(db, userId, values, Date.now()).run();
  return (await getNotificationSettings(db, [userId])).get(userId)!;
}

export async function getPrivacySettings(db: D1Database, userId: string): Promise<PrivacySettings> {
  const allow = await repo.findAllowFeaturing(db, userId);
  return { allowFeaturing: allow === null ? true : allow !== 0 };
}

/** Statement (not run), to group in a batch. */
export function updatePrivacySettings(db: D1Database, userId: string, allowFeaturing: boolean): D1PreparedStatement {
  return repo.upsertAllowFeaturing(db, userId, allowFeaturing, Date.now());
}
