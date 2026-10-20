export type Env = {
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
  /** App Review account: for this email no email is sent and REVIEW_CODE is accepted as the code. */
  REVIEW_EMAIL?: string;
  REVIEW_CODE?: string;
};

export type Role = "admin" | "member";

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
  created_at: number;
};

export type UserRow = {
  id: string;
  email: string;
  name: string | null;
  username: string | null;
  avatar_key: string | null;
  pending_avatar_key: string | null;
  created_at: number;
};

export type MemberRow = {
  id: string;
  trip_id: string;
  user_id: string;
  role: Role;
  created_at: number;
  removed_at: number | null;
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
  original_key: string;
  thumb_key: string;
  status: "pending" | "uploaded";
  created_at: number;
  uploaded_at: number | null;
  deleted_at: number | null;
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
