import { env, exports } from "cloudflare:workers";
import app from "../src/index";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const TZ = "America/Argentina/Buenos_Aires";

export type ApiResponse<T = any> = { status: number; body: T; headers: Headers };

/** Calls the API inside the same Workers runtime, without a network. */
export async function api<T = any>(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; env?: Record<string, unknown>; origin?: string } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  const req = new Request(`${opts.origin ?? "https://rollo.test"}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  // `env` overrides bindings for this request (e.g. dev-only variables).
  const res = opts.env ? await app.request(req, undefined, { ...env, ...opts.env }) : await exports.default.fetch(req);
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? await res.json() : new TextDecoder().decode(await res.arrayBuffer());
  return { status: res.status, body: body as T, headers: res.headers };
}

export type TripFixture = {
  tripId: string;
  code: string;
  adminToken: string;
  adminId: string;
};

/** Creates an ongoing trip: started yesterday, ends in 9 days, reveals in 10. */
export async function createTrip(overrides: Record<string, unknown> = {}): Promise<TripFixture> {
  const now = Date.now();
  const res = await api("POST", "/trips", {
    body: {
      name: "Viaje al sur",
      adminName: "Juani",
      timezone: TZ,
      startsAt: now - DAY,
      endsAt: now + 9 * DAY,
      revealAt: now + 10 * DAY,
      dailyPhotoLimit: 2,
      dailyVideoLimit: 1,
      ...overrides,
    },
  });
  if (res.status !== 201) throw new Error(`createTrip failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    tripId: res.body.trip.id,
    code: res.body.trip.joinCode,
    adminToken: res.body.token,
    adminId: res.body.member.id,
  };
}

export async function join(code: string, name: string): Promise<{ token: string; memberId: string }> {
  const res = await api("POST", "/trips/join", { body: { code, name } });
  if (res.status !== 201) throw new Error(`join failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, memberId: res.body.member.id };
}

export function photoBody(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    type: "photo",
    takenAt: Date.now() - MINUTE,
    lat: -49.33,
    lng: -72.88,
    accuracyM: 12,
    caption: "no puedo creer este viento",
    width: 4032,
    height: 3024,
    sizeBytes: 2_500_000,
    ...overrides,
  };
}

export function videoBody(overrides: Record<string, unknown> = {}) {
  return photoBody({ type: "video", durationS: 12, sizeBytes: 8_000_000, caption: null, ...overrides });
}

/** Simulates the phone uploading the files to R2 (in tests the signed PUT never hits the network). */
export async function putFiles(tripId: string, mediaId: string, type: "photo" | "video" = "photo") {
  const base = `trips/${tripId}/${mediaId}`;
  await env.MEDIA.put(`${base}/original.${type === "video" ? "mp4" : "jpg"}`, `original-${mediaId}`);
  await env.MEDIA.put(`${base}/thumb.jpg`, `thumb-${mediaId}`);
}

/** Registers, "uploads" and confirms a photo or video. Returns the id. */
export async function uploadMedia(
  tripId: string,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const body = overrides.type === "video" ? videoBody(overrides) : photoBody(overrides);
  const reg = await api("POST", `/trips/${tripId}/media`, { body, token });
  if (reg.status !== 201) throw new Error(`registration failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  await putFiles(tripId, body.id, body.type as "photo" | "video");
  const done = await api("POST", `/media/${body.id}/complete`, { token });
  if (done.status !== 200) throw new Error(`complete failed: ${done.status} ${JSON.stringify(done.body)}`);
  return body.id;
}
