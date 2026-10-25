/** Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc). */
export type RateLimitBinding = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type Env = {
  /** Rate limiters (see `src/lib/rate-limit.ts`); optional so a missing binding fails open. */
  RL_GLOBAL?: RateLimitBinding;
  RL_IP?: RateLimitBinding;
  RL_EXPENSIVE?: RateLimitBinding;
  RL_FILES?: RateLimitBinding;
  DB: D1Database;
  MEDIA: R2Bucket;
  R2_BUCKET_NAME: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /** Only in `.dev.vars`: "1" sends uploads to the worker itself and the local R2. */
  DEV_LOCAL_UPLOADS?: string;
  /** Resend API key. Without it, login codes are only logged to the console (dev). */
  RESEND_API_KEY?: string;
  /** Sender of the login emails, e.g. "Rollo <rollo@juanifraga.com>". */
  EMAIL_FROM?: string;
  /** Where report emails go. Defaults to soporte@juanifraga.com. */
  REPORTS_EMAIL?: string;
  /** Bearer token for the `/admin/*` routes (delete media or accounts). Without it those routes are disabled. */
  ADMIN_TOKEN?: string;
  /** Base URL of the login magic link (default https://rollo.juanifraga.com/entrar); token and email go in its fragment. */
  LOGIN_LINK_URL?: string;
  /** R2 storage limit in bytes (decimal string). Defaults to 10 GB, R2's free tier; uploads stop at 95% of it. */
  STORAGE_LIMIT_BYTES?: string;
  /** App Review account: for this email no email is sent and REVIEW_CODE is accepted as the code. */
  REVIEW_EMAIL?: string;
  REVIEW_CODE?: string;
};

export type Role = "admin" | "member";

/** Who can see your bio and featured photos. */
export type ProfileVisibility = "friends" | "public";

export type TripRow = {
  id: string;
  name: string;
  join_code: string;
  timezone: string;
  starts_at: number;
  ends_at: number;
  reveal_at: number;
  revealed_at: number | null;
  daily_photo_limit: number;
  daily_video_limit: number;
  photo_limit_mode: "daily" | "total";
  total_photo_limit: number | null;
  created_at: number;
  /** When the "rollo started" push was sent (or the trip had already started when notifications shipped). */
  started_notified_at: number | null;
  /** When the "rollo revealed" push was sent (or the trip had already revealed when notifications shipped). */
  revealed_notified_at: number | null;
  /** Private rollo: nobody can feature its photos (0/1). */
  featuring_disabled: number;
  /** Daily moment: 'off' | 'photo' | 'photo_selfie'. */
  moment_mode: "off" | "photo" | "photo_selfie";
  /** Moment window, minutes from midnight in the trip's time zone. */
  moment_window_start: number;
  moment_window_end: number;
};

export type UserRow = {
  id: string;
  email: string;
  name: string | null;
  username: string | null;
  avatar_key: string | null;
  pending_avatar_key: string | null;
  bio: string | null;
  badge: string | null;
  profile_visibility: ProfileVisibility;
  created_at: number;
};

export type MemberRow = {
  id: string;
  trip_id: string;
  user_id: string;
  role: Role;
  created_at: number;
  removed_at: number | null;
  left_at: number | null;
  added_by_user_id: string | null;
  /** Others may feature this member's photos of the rollo (0/1). */
  allow_featuring: number;
};

export type MediaType = "photo" | "video";

export type MediaRow = {
  id: string;
  trip_id: string;
  member_id: string;
  type: MediaType;
  taken_at: number;
  local_date: string;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  caption: string | null;
  thumbhash: string | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  /** Exact byte size of the thumbnail the upload URL is signed for (null: legacy row). */
  thumb_size_bytes: number | null;
  original_key: string;
  thumb_key: string;
  status: "pending" | "uploaded";
  created_at: number;
  uploaded_at: number | null;
  deleted_at: number | null;
  /** The author does not let others feature this photo. */
  feature_blocked_at: number | null;
  /** Last time a like on this photo sent a push (anti-spam window). */
  like_notified_at: number | null;
  /** Likes since like_notified_at that did not send a push. */
  likes_since_notified: number;
  /** Last time a comment on this photo sent a push (anti-spam window). */
  comment_notified_at: number | null;
  /** Comments since comment_notified_at that did not send a push. */
  comments_since_notified: number;
};

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserRow;
    sessionId: string;
    member: MemberRow;
    trip: TripRow;
  };
};
