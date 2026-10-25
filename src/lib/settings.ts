/** Notification preferences: API key → user_settings column. Every one defaults to on. */
export const NOTIFICATION_COLUMNS = {
  addedToTrip: "notify_added_to_trip",
  newFriend: "notify_new_friend",
  tripStarted: "notify_trip_started",
  tripRevealed: "notify_trip_revealed",
  photoFeatured: "notify_photo_featured",
  photoLiked: "notify_photo_liked",
  photoCommented: "notify_photo_commented",
  friendRequest: "notify_friend_request",
  dailyMoment: "notify_daily_moment",
  momentPosted: "notify_moment_posted",
} as const;

export type NotificationKind = keyof typeof NOTIFICATION_COLUMNS;
export type NotificationSettings = Record<NotificationKind, boolean>;

const KINDS = Object.keys(NOTIFICATION_COLUMNS) as NotificationKind[];

export function defaultNotificationSettings(): NotificationSettings {
  return Object.fromEntries(KINDS.map((k) => [k, true])) as NotificationSettings;
}

type SettingsRow = { user_id: string } & Record<(typeof NOTIFICATION_COLUMNS)[NotificationKind], number>;

function fromRow(row: SettingsRow | null | undefined): NotificationSettings {
  if (!row) return defaultNotificationSettings();
  return Object.fromEntries(KINDS.map((k) => [k, row[NOTIFICATION_COLUMNS[k]] !== 0])) as NotificationSettings;
}

// D1 caps bound parameters per statement at 100.
const CHUNK = 90;

/** Notification settings for each user id (defaults for users without a row). */
export async function getNotificationSettings(db: D1Database, userIds: string[]): Promise<Map<string, NotificationSettings>> {
  const ids = [...new Set(userIds)];
  const rows = new Map<string, SettingsRow>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { results } = await db
      .prepare(`SELECT * FROM user_settings WHERE user_id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<SettingsRow>();
    for (const r of results) rows.set(r.user_id, r);
  }
  return new Map(ids.map((id) => [id, fromRow(rows.get(id))]));
}

/** Applies a partial update and returns the resulting settings. Keys left out keep their value (or the default). */
export async function updateNotificationSettings(
  db: D1Database,
  userId: string,
  patch: Partial<NotificationSettings>,
): Promise<NotificationSettings> {
  const kinds = KINDS.filter((k) => patch[k] !== undefined);
  if (kinds.length > 0) {
    const columns = kinds.map((k) => NOTIFICATION_COLUMNS[k]);
    // Only the sent columns are written (atomic per column); a new row takes the defaults for the rest.
    await db
      .prepare(
        `INSERT INTO user_settings (user_id, ${columns.join(", ")}, updated_at) VALUES (?, ${columns.map(() => "?").join(", ")}, ?)
         ON CONFLICT (user_id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = excluded.updated_at`,
      )
      .bind(userId, ...kinds.map((k) => (patch[k] ? 1 : 0)), Date.now())
      .run();
  }
  return (await getNotificationSettings(db, [userId])).get(userId)!;
}

export type PrivacySettings = { allowFeaturing: boolean };

export async function getPrivacySettings(db: D1Database, userId: string): Promise<PrivacySettings> {
  const row = await db.prepare("SELECT allow_featuring FROM user_settings WHERE user_id = ?").bind(userId).first<{ allow_featuring: number }>();
  return { allowFeaturing: row ? row.allow_featuring !== 0 : true };
}

/** Statement (not run): a new row takes the defaults for the rest. */
export function updatePrivacySettings(db: D1Database, userId: string, allowFeaturing: boolean): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO user_settings (user_id, allow_featuring, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET allow_featuring = excluded.allow_featuring, updated_at = excluded.updated_at`,
    )
    .bind(userId, allowFeaturing ? 1 : 0, Date.now());
}
