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

export const NOTIFICATION_KINDS = Object.keys(NOTIFICATION_COLUMNS) as NotificationKind[];

export function defaultNotificationSettings(): NotificationSettings {
  return Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, true])) as NotificationSettings;
}

export type SettingsRow = { user_id: string } & Record<(typeof NOTIFICATION_COLUMNS)[NotificationKind], number>;

export function notificationSettingsFromRow(row: SettingsRow | null | undefined): NotificationSettings {
  if (!row) return defaultNotificationSettings();
  return Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, row[NOTIFICATION_COLUMNS[k]] !== 0])) as NotificationSettings;
}
