// Drizzle schema of the whole D1 database, written from migrations/0001..0019 (the migrations stay the source of
// truth for the real DB; `npm run db:check-schema` fails if this file drifts from them).
// Conventions: TS properties are camelCase, DB column names are the unchanged snake_case. Booleans and dates stay
// the integers they are in the DB (epoch milliseconds, 0/1): no `mode` conversions, values are identical.
// Known gap: Drizzle can't express `COLLATE NOCASE` (users.email, auth_codes.email); queries that rely on it are
// still covered by the migration, not by this file.
import { relations, sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";

export const trips = sqliteTable("trips", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  joinCode: text("join_code").notNull().unique(),
  timezone: text("timezone").notNull(),
  startsAt: integer("starts_at").notNull(),
  endsAt: integer("ends_at").notNull(),
  revealAt: integer("reveal_at").notNull(),
  revealedAt: integer("revealed_at"),
  dailyPhotoLimit: integer("daily_photo_limit").notNull().default(10),
  dailyVideoLimit: integer("daily_video_limit").notNull().default(3),
  photoLimitMode: text("photo_limit_mode").notNull().default("daily"),
  totalPhotoLimit: integer("total_photo_limit"),
  createdAt: integer("created_at").notNull(),
  startedNotifiedAt: integer("started_notified_at"),
  revealedNotifiedAt: integer("revealed_notified_at"),
  featuringDisabled: integer("featuring_disabled").notNull().default(0),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    name: text("name"),
    avatarKey: text("avatar_key"),
    pendingAvatarKey: text("pending_avatar_key"),
    createdAt: integer("created_at").notNull(),
    username: text("username"),
    bio: text("bio"),
    profileVisibility: text("profile_visibility", { enum: ["friends", "public"] }).notNull().default("friends"),
    badge: text("badge", { enum: ["founder", "first_edition"] }),
  },
  (t) => [
    uniqueIndex("idx_users_username").on(t.username),
    check("users_badge_check", sql`${t.badge} IN ('founder', 'first_edition')`),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("idx_sessions_user").on(t.userId)],
);

export const authCodes = sqliteTable(
  "auth_codes",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    ip: text("ip"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    linkHash: text("link_hash"),
    linkChallenge: text("link_challenge"),
  },
  (t) => [index("idx_auth_codes_email").on(t.email, t.createdAt), index("idx_auth_codes_ip").on(t.ip, t.createdAt)],
);

export const members = sqliteTable(
  "members",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id").notNull().references(() => trips.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    removedAt: integer("removed_at"),
    leftAt: integer("left_at"),
    addedByUserId: text("added_by_user_id"),
    allowFeaturing: integer("allow_featuring").notNull().default(1),
  },
  (t) => [
    unique().on(t.tripId, t.userId),
    index("idx_members_user").on(t.userId),
    check("members_role_check", sql`${t.role} IN ('admin', 'member')`),
  ],
);

export const media = sqliteTable(
  "media",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id").notNull().references(() => trips.id, { onDelete: "cascade" }),
    memberId: text("member_id").notNull().references(() => members.id),
    type: text("type", { enum: ["photo", "video"] }).notNull(),
    takenAt: integer("taken_at").notNull(),
    localDate: text("local_date").notNull(),
    lat: real("lat"),
    lng: real("lng"),
    accuracyM: real("accuracy_m"),
    caption: text("caption"),
    durationS: real("duration_s"),
    width: integer("width"),
    height: integer("height"),
    sizeBytes: integer("size_bytes"),
    originalKey: text("original_key").notNull(),
    thumbKey: text("thumb_key").notNull(),
    status: text("status", { enum: ["pending", "uploaded"] }).notNull().default("pending"),
    createdAt: integer("created_at").notNull(),
    uploadedAt: integer("uploaded_at"),
    thumbhash: text("thumbhash"),
    deletedAt: integer("deleted_at"),
    featureBlockedAt: integer("feature_blocked_at"),
    likeNotifiedAt: integer("like_notified_at"),
    likesSinceNotified: integer("likes_since_notified").notNull().default(0),
    commentNotifiedAt: integer("comment_notified_at"),
    commentsSinceNotified: integer("comments_since_notified").notNull().default(0),
    thumbSizeBytes: integer("thumb_size_bytes"),
  },
  (t) => [
    index("idx_media_trip_time").on(t.tripId, t.takenAt),
    index("idx_media_member_day").on(t.memberId, t.localDate, t.type),
    check("media_type_check", sql`${t.type} IN ('photo', 'video')`),
    check("media_status_check", sql`${t.status} IN ('pending', 'uploaded')`),
  ],
);

export const friendships = sqliteTable(
  "friendships",
  {
    userA: text("user_a").notNull().references(() => users.id, { onDelete: "cascade" }),
    userB: text("user_b").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userA, t.userB] }),
    index("idx_friendships_b").on(t.userB),
    check("friendships_order_check", sql`${t.userA} < ${t.userB}`),
  ],
);

export const friendLinks = sqliteTable(
  "friend_links",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull().unique(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("idx_friend_links_user").on(t.userId)],
);

export const friendClaims = sqliteTable("friend_claims", {
  id: text("id").primaryKey(),
  linkUserId: text("link_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  claimHash: text("claim_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
});

export const friendAttempts = sqliteTable(
  "friend_attempts",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_friend_attempts_key").on(t.key, t.createdAt)],
);

export const featured = sqliteTable(
  "featured",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    mediaId: text("media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.mediaId] }),
    index("idx_featured_user").on(t.userId, t.createdAt),
    index("idx_featured_media").on(t.mediaId),
  ],
);

export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    reporterId: text("reporter_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    mediaId: text("media_id").references(() => media.id, { onDelete: "cascade" }),
    targetUserId: text("target_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tripId: text("trip_id"),
    reason: text("reason").notNull(),
    createdAt: integer("created_at").notNull(),
    unemailed: integer("unemailed").notNull().default(0),
    commentId: text("comment_id").references(() => comments.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("idx_reports_media").on(t.reporterId, t.mediaId).where(sql`${t.mediaId} IS NOT NULL`),
    uniqueIndex("idx_reports_comment").on(t.reporterId, t.commentId).where(sql`${t.commentId} IS NOT NULL`),
    uniqueIndex("idx_reports_user").on(t.reporterId, t.targetUserId).where(sql`${t.mediaId} IS NULL AND ${t.commentId} IS NULL`),
    index("idx_reports_unemailed").on(t.createdAt).where(sql`${t.unemailed} = 1`),
  ],
);

export const blocks = sqliteTable(
  "blocks",
  {
    blockerId: text("blocker_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    blockedId: text("blocked_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    unemailed: integer("unemailed").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.blockerId, t.blockedId] }),
    index("idx_blocks_blocked").on(t.blockedId),
    index("idx_blocks_unemailed").on(t.createdAt).where(sql`${t.unemailed} = 1`),
  ],
);

export const pushTokens = sqliteTable(
  "push_tokens",
  {
    token: text("token").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (t) => [index("idx_push_tokens_user").on(t.userId), index("idx_push_tokens_session").on(t.sessionId)],
);

export const friendRequests = sqliteTable(
  "friend_requests",
  {
    fromUserId: text("from_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    toUserId: text("to_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    rejectedAt: integer("rejected_at"),
    cancelledAt: integer("cancelled_at"),
  },
  (t) => [
    primaryKey({ columns: [t.fromUserId, t.toUserId] }),
    index("idx_friend_requests_to").on(t.toUserId),
    index("idx_friend_requests_from_time").on(t.fromUserId, t.createdAt),
  ],
);

export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  notifyAddedToTrip: integer("notify_added_to_trip").notNull().default(1),
  notifyNewFriend: integer("notify_new_friend").notNull().default(1),
  notifyTripStarted: integer("notify_trip_started").notNull().default(1),
  notifyTripRevealed: integer("notify_trip_revealed").notNull().default(1),
  notifyPhotoFeatured: integer("notify_photo_featured").notNull().default(1),
  notifyPhotoLiked: integer("notify_photo_liked").notNull().default(1),
  notifyPhotoCommented: integer("notify_photo_commented").notNull().default(1),
  notifyFriendRequest: integer("notify_friend_request").notNull().default(1),
  allowFeaturing: integer("allow_featuring").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});

export const likes = sqliteTable(
  "likes",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    mediaId: text("media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.mediaId] }), index("idx_likes_media").on(t.mediaId)],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    mediaId: text("media_id").notNull().references(() => media.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("idx_comments_media").on(t.mediaId, t.createdAt), index("idx_comments_user").on(t.userId)],
);

export const pushReceipts = sqliteTable(
  "push_receipts",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_push_receipts_created").on(t.createdAt)],
);

export const cronState = sqliteTable("cron_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const emailCounters = sqliteTable(
  "email_counters",
  {
    kind: text("kind").notNull(),
    day: text("day").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.day] })],
);

// Relations (for the relational query API, `db.query.x.findFirst({ with })`); one per foreign key.

export const tripsRelations = relations(trips, ({ many }) => ({
  members: many(members),
  media: many(media),
}));

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  members: many(members),
  friendLinks: many(friendLinks),
  friendClaims: many(friendClaims),
  featured: many(featured),
  likes: many(likes),
  pushTokens: many(pushTokens),
  settings: one(userSettings),
  reportsMade: many(reports, { relationName: "reporter" }),
  reportsReceived: many(reports, { relationName: "reportTarget" }),
  blocksMade: many(blocks, { relationName: "blocker" }),
  blocksReceived: many(blocks, { relationName: "blocked" }),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
  pushTokens: many(pushTokens),
}));

export const membersRelations = relations(members, ({ one, many }) => ({
  trip: one(trips, { fields: [members.tripId], references: [trips.id] }),
  user: one(users, { fields: [members.userId], references: [users.id] }),
  media: many(media),
}));

export const mediaRelations = relations(media, ({ one, many }) => ({
  trip: one(trips, { fields: [media.tripId], references: [trips.id] }),
  member: one(members, { fields: [media.memberId], references: [members.id] }),
  featured: many(featured),
  likes: many(likes),
  reports: many(reports),
}));

export const friendshipsRelations = relations(friendships, ({ one }) => ({
  userA: one(users, { fields: [friendships.userA], references: [users.id], relationName: "friendshipA" }),
  userB: one(users, { fields: [friendships.userB], references: [users.id], relationName: "friendshipB" }),
}));

export const friendLinksRelations = relations(friendLinks, ({ one }) => ({
  user: one(users, { fields: [friendLinks.userId], references: [users.id] }),
}));

export const friendClaimsRelations = relations(friendClaims, ({ one }) => ({
  linkUser: one(users, { fields: [friendClaims.linkUserId], references: [users.id] }),
}));

export const featuredRelations = relations(featured, ({ one }) => ({
  user: one(users, { fields: [featured.userId], references: [users.id] }),
  media: one(media, { fields: [featured.mediaId], references: [media.id] }),
}));

export const reportsRelations = relations(reports, ({ one }) => ({
  reporter: one(users, { fields: [reports.reporterId], references: [users.id], relationName: "reporter" }),
  media: one(media, { fields: [reports.mediaId], references: [media.id] }),
  targetUser: one(users, { fields: [reports.targetUserId], references: [users.id], relationName: "reportTarget" }),
}));

export const blocksRelations = relations(blocks, ({ one }) => ({
  blocker: one(users, { fields: [blocks.blockerId], references: [users.id], relationName: "blocker" }),
  blocked: one(users, { fields: [blocks.blockedId], references: [users.id], relationName: "blocked" }),
}));

export const pushTokensRelations = relations(pushTokens, ({ one }) => ({
  user: one(users, { fields: [pushTokens.userId], references: [users.id] }),
  session: one(sessions, { fields: [pushTokens.sessionId], references: [sessions.id] }),
}));

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(users, { fields: [userSettings.userId], references: [users.id] }),
}));

export const likesRelations = relations(likes, ({ one }) => ({
  user: one(users, { fields: [likes.userId], references: [users.id] }),
  media: one(media, { fields: [likes.mediaId], references: [media.id] }),
}));

// Inferred row types (select) and insert shapes.
export type Trip = typeof trips.$inferSelect;
export type NewTrip = typeof trips.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type AuthCode = typeof authCodes.$inferSelect;
export type NewAuthCode = typeof authCodes.$inferInsert;
export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;
export type Media = typeof media.$inferSelect;
export type NewMedia = typeof media.$inferInsert;
export type FriendRequest = typeof friendRequests.$inferSelect;
export type Friendship = typeof friendships.$inferSelect;
export type NewFriendship = typeof friendships.$inferInsert;
export type FriendLink = typeof friendLinks.$inferSelect;
export type NewFriendLink = typeof friendLinks.$inferInsert;
export type FriendClaim = typeof friendClaims.$inferSelect;
export type NewFriendClaim = typeof friendClaims.$inferInsert;
export type FriendAttempt = typeof friendAttempts.$inferSelect;
export type NewFriendAttempt = typeof friendAttempts.$inferInsert;
export type Featured = typeof featured.$inferSelect;
export type NewFeatured = typeof featured.$inferInsert;
export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
export type Block = typeof blocks.$inferSelect;
export type NewBlock = typeof blocks.$inferInsert;
export type PushToken = typeof pushTokens.$inferSelect;
export type NewPushToken = typeof pushTokens.$inferInsert;
export type UserSettings = typeof userSettings.$inferSelect;
export type NewUserSettings = typeof userSettings.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
export type Like = typeof likes.$inferSelect;
export type NewLike = typeof likes.$inferInsert;
export type PushReceipt = typeof pushReceipts.$inferSelect;
export type NewPushReceipt = typeof pushReceipts.$inferInsert;
export type CronState = typeof cronState.$inferSelect;
export type NewCronState = typeof cronState.$inferInsert;
export type EmailCounter = typeof emailCounters.$inferSelect;
export type NewEmailCounter = typeof emailCounters.$inferInsert;
