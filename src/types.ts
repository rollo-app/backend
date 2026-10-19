export type Env = {
  DB: D1Database;
  MEDIA: R2Bucket;
  R2_BUCKET_NAME: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /** Solo en `.dev.vars`: "1" hace que las subidas vayan al propio worker y al R2 local. */
  DEV_LOCAL_UPLOADS?: string;
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

export type MemberRow = {
  id: string;
  trip_id: string;
  name: string;
  role: Role;
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
};

export type AppEnv = {
  Bindings: Env;
  Variables: {
    member: MemberRow;
    trip: TripRow;
  };
};
