import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { devSentBlocks, devSentReports } from "../src/lib/email";
import { LOGIN_EMAILS_PER_DAY, MODERATION_ACTIONS_PER_DAY, SUPPORT_EMAILS_PER_DAY } from "../src/lib/email-caps";
import { api, newTrip, requestCode, signUp, uploadMedia, DAY } from "./helpers";

/** In-memory stand-in for a Workers Rate Limiting binding, with a fixed limit and no window. */
function fakeLimiter(limit: number) {
  const counts = new Map<string, number>();
  return {
    keys: counts,
    limit: async ({ key }: { key: string }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}

const TOO_FAST = "Estás yendo muy rápido. Probá de nuevo en un minuto.";
const today = () => new Date().toISOString().slice(0, 10);

describe("rate limit bindings", () => {
  it("are configured in the test environment", () => {
    for (const name of ["RL_GLOBAL", "RL_IP", "RL_EXPENSIVE", "RL_FILES"] as const) {
      expect(typeof env[name]!.limit).toBe("function");
    }
  });
});

describe("global limit", () => {
  it("answers 429 over the limit, per user, and does not affect other users", async () => {
    const a = await signUp();
    const b = await signUp();
    const e = { RL_GLOBAL: fakeLimiter(2) };
    expect((await api("GET", "/me", { token: a.token, env: e })).status).toBe(200);
    expect((await api("GET", "/me", { token: a.token, env: e })).status).toBe(200);
    const blocked = await api("GET", "/me", { token: a.token, env: e });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: TOO_FAST });
    expect((await api("GET", "/me", { token: b.token, env: e })).status).toBe(200);
  });

  it("keys anonymous requests by IP", async () => {
    const e = { RL_GLOBAL: fakeLimiter(1) };
    const h = (ip: string) => ({ headers: { "cf-connecting-ip": ip }, env: e });
    expect((await api("GET", "/", h("1.1.1.1"))).status).toBe(200);
    expect((await api("GET", "/", h("1.1.1.1"))).status).toBe(429);
    expect((await api("GET", "/", h("2.2.2.2"))).status).toBe(200);
  });

  it("limits each IP across tokens with RL_IP, so rotating tokens does not help", async () => {
    const e = { RL_GLOBAL: fakeLimiter(100), RL_IP: fakeLimiter(2) };
    const headers = { "cf-connecting-ip": "3.3.3.3" };
    for (let i = 0; i < 2; i++) expect((await api("GET", "/me", { token: `fake${i}`, headers, env: e })).status).toBe(401);
    expect((await api("GET", "/me", { token: "fake9", headers, env: e })).status).toBe(429);
  });

  it("skips /openapi.json and /docs", async () => {
    const e = { RL_GLOBAL: fakeLimiter(0), RL_IP: fakeLimiter(0) };
    expect((await api("GET", "/openapi.json", { env: e })).status).toBe(200);
    expect((await api("GET", "/docs", { env: e })).status).toBe(200);
  });

  it("lets requests through when the bindings are missing", async () => {
    const a = await signUp();
    const e = { RL_GLOBAL: undefined, RL_IP: undefined, RL_EXPENSIVE: undefined, RL_FILES: undefined };
    expect((await api("GET", "/me", { token: a.token, env: e })).status).toBe(200);
    expect((await api("POST", "/me/avatar", { token: a.token, body: { sizeBytes: 100 }, env: e })).status).toBe(200);
  });
});

describe("expensive endpoints", () => {
  it("limit per user", async () => {
    const a = await signUp();
    const b = await signUp();
    const e = { RL_EXPENSIVE: fakeLimiter(2) };
    const avatar = (token: string) => api("POST", "/me/avatar", { token, body: { sizeBytes: 100 }, env: e });
    expect((await avatar(a.token)).status).toBe(200);
    expect((await avatar(a.token)).status).toBe(200);
    const blocked = await avatar(a.token);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: TOO_FAST });
    expect((await avatar(b.token)).status).toBe(200);
    // Cheap endpoints do not use it.
    expect((await api("GET", "/me", { token: a.token, env: e })).status).toBe(200);
  });

  it("cover registering media, completing, likes and adding members", async () => {
    const trip = await newTrip();
    const e = { RL_EXPENSIVE: fakeLimiter(0) };
    const token = trip.adminToken;
    expect((await api("POST", `/trips/${trip.tripId}/media`, { token, body: {}, env: e })).status).toBe(429);
    expect((await api("POST", `/media/${crypto.randomUUID()}/complete`, { token, env: e })).status).toBe(429);
    expect((await api("POST", "/me/avatar/complete", { token, env: e })).status).toBe(429);
    expect((await api("PUT", `/media/${crypto.randomUUID()}/like`, { token, env: e })).status).toBe(429);
    expect((await api("POST", `/trips/${trip.tripId}/members`, { token, body: { friendIds: [] }, env: e })).status).toBe(429);
  });
});

describe("file downloads", () => {
  it("use their own, more generous limiter", async () => {
    const trip = await newTrip();
    const mediaId = await uploadMedia(trip.tripId, trip.adminToken);
    const url = `/trips/${trip.tripId}/media/${mediaId}/thumb`;
    const token = trip.adminToken;
    expect((await api("GET", url, { token, env: { RL_FILES: fakeLimiter(0) } })).status).toBe(429);
    // RL_EXPENSIVE is not involved: with a roomy RL_FILES it gets past the limiter (403: not revealed yet).
    expect((await api("GET", url, { token, env: { RL_FILES: fakeLimiter(5), RL_EXPENSIVE: fakeLimiter(0) } })).status).toBe(403);
    expect((await api("GET", `/featured/${trip.adminUserId}/${mediaId}/thumb`, { token, env: { RL_FILES: fakeLimiter(0) } })).status).toBe(429);
  });
});

/** A user row inserted directly: signing up 100 users would hit the daily login email cap. */
async function bareUser(): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(id, `${id}@rollo.test`, Date.now()).run();
  return id;
}

describe("daily email caps", () => {
  it("login emails: 429 over the global daily cap, and it resets the next day", async () => {
    await env.DB.prepare("INSERT INTO email_counters (kind, day, count) VALUES ('login', ?, ?)").bind(today(), LOGIN_EMAILS_PER_DAY).run();
    const res = await api("POST", "/auth/email/start", { body: { email: "cap@rollo.test" } });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "Hay muchos pedidos de código ahora. Probá en un rato." });
    await env.DB.prepare("UPDATE email_counters SET day = '2000-01-01'").run();
    expect((await api("POST", "/auth/email/start", { body: { email: "cap@rollo.test" } })).status).toBe(204);
  });

  it("login emails under the cap are counted", async () => {
    await requestCode("count@rollo.test");
    const row = await env.DB.prepare("SELECT count FROM email_counters WHERE kind = 'login'").first<{ count: number }>();
    expect(row!.count).toBe(1);
  });

  it("support emails: over the global cap the report and the block are saved but not emailed", async () => {
    devSentReports.length = 0;
    devSentBlocks.length = 0;
    await env.DB.prepare("INSERT INTO email_counters (kind, day, count) VALUES ('support', ?, ?)").bind(today(), SUPPORT_EMAILS_PER_DAY).run();
    const a = await signUp();
    const b = await signUp();
    const c = await signUp();
    expect((await api("POST", "/reports", { token: a.token, body: { userId: b.userId, reason: "abuse" } })).status).toBe(204);
    expect((await api("PUT", `/blocks/${c.userId}`, { token: a.token })).status).toBe(204);
    expect(devSentReports).toHaveLength(0);
    expect(devSentBlocks).toHaveLength(0);
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ?").bind(a.userId).first<{ n: number }>();
    const k = await env.DB.prepare("SELECT COUNT(*) AS n FROM blocks WHERE blocker_id = ?").bind(a.userId).first<{ n: number }>();
    expect([r!.n, k!.n]).toEqual([1, 1]);
  });

  it("support emails under the cap are sent and counted", async () => {
    devSentReports.length = 0;
    const a = await signUp();
    const b = await signUp();
    await api("POST", "/reports", { token: a.token, body: { userId: b.userId, reason: "abuse" } });
    expect(devSentReports).toHaveLength(1);
    const row = await env.DB.prepare("SELECT count FROM email_counters WHERE kind = 'support'").first<{ count: number }>();
    expect(row!.count).toBe(1);
  });

  it("moderation: a user past the daily action cap gets 429 and nothing is stored", async () => {
    const a = await signUp();
    const when = Date.now() - DAY / 2;
    for (let i = 0; i < MODERATION_ACTIONS_PER_DAY; i++) {
      await env.DB.prepare("INSERT INTO reports (id, reporter_id, media_id, target_user_id, trip_id, reason, created_at) VALUES (?, ?, NULL, ?, NULL, 'other', ?)")
        .bind(crypto.randomUUID(), a.userId, await bareUser(), when)
        .run();
      await env.DB.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)")
        .bind(a.userId, await bareUser(), when)
        .run();
    }
    const t1 = await signUp();
    const t2 = await signUp();
    const rep = await api("POST", "/reports", { token: a.token, body: { userId: t1.userId, reason: "abuse" } });
    expect(rep.status).toBe(429);
    expect(typeof rep.body.error).toBe("string");
    expect((await api("PUT", `/blocks/${t2.userId}`, { token: a.token })).status).toBe(429);
    const k = await env.DB.prepare("SELECT COUNT(*) AS n FROM blocks WHERE blocker_id = ? AND blocked_id = ?").bind(a.userId, t2.userId).first<{ n: number }>();
    expect(k!.n).toBe(0);
    // Another user is not affected.
    const other = await signUp();
    expect((await api("POST", "/reports", { token: other.token, body: { userId: t1.userId, reason: "abuse" } })).status).toBe(204);
  });
});
