import { env, exports } from "cloudflare:workers";
import { vi } from "vitest";
import app from "../src/index";
import { devSentCodes } from "../src/lib/email";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const TZ = "America/Argentina/Buenos_Aires";

export type ApiResponse<T = any> = { status: number; body: T; headers: Headers };

/** Calls the API inside the same Workers runtime, without a network. */
export async function api<T = any>(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; env?: Record<string, unknown>; origin?: string; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...opts.headers };
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

let userCounter = 0;

/**
 * Signs a user up through the real login flow (start + verify) and optionally sets their name.
 * Without RESEND_API_KEY the code is "sent" to `devSentCodes`, which is where the test reads it.
 * Pass `name = null` / `username = null` to leave the profile without a name / username.
 * By default the username is a random unique one.
 */
export async function signUp(
  email = `user${++userCounter}@rollo.test`,
  name: string | null = "Test",
  username: string | null = `u${userCounter}${Math.random().toString(36).slice(2, 8)}`,
): Promise<{ token: string; userId: string; email: string }> {
  const code = await requestCode(email);
  const res = await api("POST", "/auth/email/verify", { body: { email, code } });
  if (res.status !== 200) throw new Error(`verify failed: ${res.status} ${JSON.stringify(res.body)}`);
  const { token, user } = res.body;
  if (name !== null || username !== null) {
    const patched = await api("PATCH", "/me", {
      token,
      body: { ...(name !== null && { name }), ...(username !== null && { username }) },
    });
    if (patched.status !== 200) throw new Error(`PATCH /me failed: ${patched.status} ${JSON.stringify(patched.body)}`);
  }
  return { token, userId: user.id, email: user.email };
}

/** Signs up an account and promotes it to superadmin (the backoffice role). */
export async function makeSuperadmin(email?: string): Promise<{ token: string; userId: string; email: string }> {
  const su = await signUp(email);
  await env.DB.prepare("UPDATE users SET app_role = 'superadmin' WHERE id = ?").bind(su.userId).run();
  return su;
}

/** Logs an existing account in again: a new session (another phone). Returns its token. */
export async function logIn(email: string): Promise<string> {
  // Skip the resend throttle: pretend the previous codes were requested an hour ago.
  await env.DB.prepare("UPDATE auth_codes SET created_at = created_at - ? WHERE email = ?").bind(2 * HOUR, email.trim().toLowerCase()).run();
  const code = await requestCode(email);
  const res = await api("POST", "/auth/email/verify", { body: { email, code } });
  if (res.status !== 200) throw new Error(`verify failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token;
}

/** Calls start and returns the code that "was emailed". */
export async function requestCode(email: string): Promise<string> {
  devSentCodes.delete(email.trim().toLowerCase());
  const res = await api("POST", "/auth/email/start", { body: { email } });
  if (res.status !== 204) throw new Error(`start failed: ${res.status} ${JSON.stringify(res.body)}`);
  const code = devSentCodes.get(email.trim().toLowerCase());
  if (!code) throw new Error("no code was captured");
  return code;
}

export type TripFixture = {
  tripId: string;
  code: string;
  adminToken: string;
  adminId: string; // membership id
  adminUserId: string;
};

/**
 * Creates an ongoing trip as `token`: started yesterday, ends in 9 days, reveals in 10.
 * The API rejects dates in the past, so it is created with valid future dates and
 * the requested ones are then written straight to D1.
 */
export async function createTrip(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<{ tripId: string; code: string; memberId: string }> {
  const now = Date.now();
  const { startsAt = now - DAY, endsAt = now + 9 * DAY, revealAt = now + 10 * DAY, ...rest } = overrides as {
    startsAt?: number;
    endsAt?: number;
    revealAt?: number;
  };
  const res = await api("POST", "/trips", {
    token,
    body: {
      name: "Viaje al sur",
      timezone: TZ,
      startsAt: now + HOUR,
      endsAt: now + 2 * HOUR,
      revealAt: now + 3 * HOUR,
      dailyPhotoLimit: 2,
      dailyVideoLimit: 1,
      ...rest,
    },
  });
  if (res.status !== 201) throw new Error(`createTrip failed: ${res.status} ${JSON.stringify(res.body)}`);
  await env.DB.prepare("UPDATE trips SET starts_at = ?, ends_at = ?, reveal_at = ? WHERE id = ?")
    .bind(startsAt, endsAt, revealAt, res.body.trip.id)
    .run();
  return { tripId: res.body.trip.id, code: res.body.trip.joinCode, memberId: res.body.member.id };
}

/** Signs up "Juani" and creates an ongoing trip as the admin. */
export async function newTrip(overrides: Record<string, unknown> = {}): Promise<TripFixture> {
  const admin = await signUp(undefined, "Juani");
  const trip = await createTrip(admin.token, overrides);
  return { tripId: trip.tripId, code: trip.code, adminToken: admin.token, adminId: trip.memberId, adminUserId: admin.userId };
}

/** Joins the trip with the invite code. Returns the membership id. */
export async function join(code: string, token: string): Promise<{ memberId: string; status: number }> {
  const res = await api("POST", "/trips/join", { body: { code }, token });
  if (res.status !== 201 && res.status !== 200) throw new Error(`join failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { memberId: res.body.member.id, status: res.status };
}

/** Signs up a new user with this name and joins the trip. */
export async function joinAs(code: string, name: string): Promise<{ token: string; memberId: string; userId: string }> {
  const user = await signUp(undefined, name);
  const { memberId } = await join(code, user.token);
  return { token: user.token, memberId, userId: user.userId };
}

/** The bytes `putFiles` stores, so the sizes declared at registration match what is "uploaded". */
export const originalContent = (mediaId: string) => `original-${mediaId}`;
export const thumbContent = (mediaId: string) => `thumb-${mediaId}`;

export function photoBody(overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as string | undefined) ?? crypto.randomUUID();
  return {
    id,
    type: "photo",
    takenAt: Date.now() - MINUTE,
    lat: -49.33,
    lng: -72.88,
    accuracyM: 12,
    caption: "no puedo creer este viento",
    width: 4032,
    height: 3024,
    sizeBytes: originalContent(id).length,
    thumbSizeBytes: thumbContent(id).length,
    ...overrides,
  };
}

export function videoBody(overrides: Record<string, unknown> = {}) {
  return photoBody({ type: "video", durationS: 12, caption: null, ...overrides });
}

/** Simulates the phone uploading the files to R2 (in tests the signed PUT never hits the network). */
export async function putFiles(tripId: string, mediaId: string, type: "photo" | "video" = "photo") {
  const base = `trips/${tripId}/${mediaId}`;
  await env.MEDIA.put(`${base}/original.${type === "video" ? "mp4" : "jpg"}`, originalContent(mediaId));
  await env.MEDIA.put(`${base}/thumb.jpg`, thumbContent(mediaId));
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

/** Makes two users friends through the real flow (A generates a link, B redeems it). */
export async function befriend(tokenA: string, tokenB: string): Promise<void> {
  const link = await api("POST", "/friends/link", { token: tokenA });
  if (link.status !== 200) throw new Error(`link failed: ${link.status} ${JSON.stringify(link.body)}`);
  const res = await api("POST", "/friends/redeem", { token: tokenB, body: { code: link.body.code } });
  if (res.status !== 200) throw new Error(`redeem failed: ${res.status} ${JSON.stringify(res.body)}`);
}

// ---------- Push notifications ----------

export type SentPush = { to: string; title?: string; body: string; sound?: string; data: { url: string } };

type Ticket = { status: "ok"; id: string } | { status: "error"; message: string; details?: { error?: string } };
type Receipt = { status: "ok" } | { status: "error"; message: string; details?: { error?: string } };

/**
 * Replaces the Expo Push API for this test (restored after each test by test/setup.ts).
 * `sent` collects every message sent; `ticketFor` decides each ticket (default: ok with a random id);
 * `receipts` answers getReceipts by id (missing ids are left out, like Expo does while they are not ready).
 */
export function mockExpo(
  opts: {
    ticketFor?: (message: SentPush) => Ticket;
    receipts?: Record<string, Receipt>;
    fail?: boolean;
  } = {},
) {
  const sent: SentPush[] = [];
  const sendBatches: number[] = [];
  const receiptRequests: string[][] = [];
  const original = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://exp.host/")) return original(input, init);
    if (opts.fail) return new Response("boom", { status: 500 });
    const body = JSON.parse(String(init?.body));
    if (url.endsWith("/push/send")) {
      const messages = body as SentPush[];
      sent.push(...messages);
      sendBatches.push(messages.length);
      const data = messages.map((m) => opts.ticketFor?.(m) ?? { status: "ok" as const, id: crypto.randomUUID() });
      return Response.json({ data });
    }
    if (url.endsWith("/push/getReceipts")) {
      const ids = body.ids as string[];
      receiptRequests.push(ids);
      const data = Object.fromEntries(ids.filter((id) => opts.receipts?.[id]).map((id) => [id, opts.receipts![id]]));
      return Response.json({ data });
    }
    return new Response("not found", { status: 404 });
  });
  return { sent, sendBatches, receiptRequests };
}

/** Registers a push token for the user through the API and returns it. */
export async function registerToken(token: string, name = crypto.randomUUID().replaceAll("-", "")): Promise<string> {
  const pushToken = `ExponentPushToken[${name}]`;
  const res = await api("PUT", `/me/push-tokens/${encodeURIComponent(pushToken)}`, { token });
  if (res.status !== 204) throw new Error(`register token failed: ${res.status} ${JSON.stringify(res.body)}`);
  return pushToken;
}
