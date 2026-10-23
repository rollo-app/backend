import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { devSentCodes } from "../src/lib/email";
import { api, DAY, HOUR, MINUTE, requestCode, signUp } from "./helpers";

const start = (email: string, extra: Parameters<typeof api>[2] = {}) =>
  api("POST", "/auth/email/start", { body: { email }, ...extra });
const verify = (email: string, code: string) => api("POST", "/auth/email/verify", { body: { email, code } });
const wrongCode = (code: string) => (code === "AAAAAA" ? "BBBBBB" : "AAAAAA");

/** Moves every code of an email back in time, so rate limits that look at created_at stop applying. */
async function ageCodes(email: string, ms: number) {
  await env.DB.prepare("UPDATE auth_codes SET created_at = created_at - ?, expires_at = expires_at - ? WHERE email = ?")
    .bind(ms, ms, email)
    .run();
}

describe("POST /auth/email/start", () => {
  it("answers 204 and sends a 6-character alphanumeric code", async () => {
    const email = "nuevo@rollo.test";
    const res = await start(email);
    expect(res.status).toBe(204);
    expect(devSentCodes.get(email)).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it("stores only a hash of the code", async () => {
    const email = "hash@rollo.test";
    const code = await requestCode(email);
    const row = await env.DB.prepare("SELECT code_hash FROM auth_codes WHERE email = ?").bind(email).first<{ code_hash: string }>();
    expect(row!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.code_hash).not.toContain(code);
  });

  it("rejects an invalid email", async () => {
    for (const email of ["", "sin-arroba", "a@b", "a b@c.com"]) {
      const res = await start(email);
      expect(res.status, email).toBe(400);
      expect(res.body).toEqual({ error: "Ingresá un email válido" });
    }
  });

  it("trims and lowercases the email", async () => {
    const res = await start("  Fede@Rollo.TEST ");
    expect(res.status).toBe(204);
    expect(devSentCodes.get("fede@rollo.test")).toBeDefined();
  });

  it("allows one code per email every 60 seconds", async () => {
    const email = "rapido@rollo.test";
    expect((await start(email)).status).toBe(204);
    const again = await start(email);
    expect(again.status).toBe(429);
    expect(again.body).toEqual({ error: "Esperá un momento antes de pedir otro código" });

    await ageCodes(email, 61_000);
    expect((await start(email)).status).toBe(204);
  });

  it("allows at most 5 codes per email per hour", async () => {
    const email = "mucho@rollo.test";
    for (let i = 0; i < 5; i++) {
      expect((await start(email)).status).toBe(204);
      await ageCodes(email, 2 * MINUTE);
    }
    expect((await start(email)).status).toBe(429);

    await ageCodes(email, HOUR);
    expect((await start(email)).status).toBe(204);
  });

  it("allows at most 20 codes per IP per hour", async () => {
    const headers = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < 20; i++) {
      expect((await start(`ip${i}@rollo.test`, { headers })).status).toBe(204);
    }
    expect((await start("ip-extra@rollo.test", { headers })).status).toBe(429);
    // Another IP, or no IP header at all, isn't affected.
    expect((await start("ip-otra@rollo.test", { headers: { "cf-connecting-ip": "203.0.113.8" } })).status).toBe(204);
    expect((await start("ip-sin@rollo.test")).status).toBe(204);
  });

  it("answers 502 and doesn't burn the rate limit if the email can't be sent", async () => {
    const email = "falla@rollo.test";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    try {
      const res = await start(email, { env: { RESEND_API_KEY: "re_test" } });
      expect(res.status).toBe(502);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect((await start(email)).status).toBe(204);
  });

  it("sends the email through Resend when there is an API key", async () => {
    const email = "resend@rollo.test";
    const realFetch = globalThis.fetch;
    const calls: { url: string; auth: string | null; body: any }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const res = await start(email, { env: { RESEND_API_KEY: "re_test", EMAIL_FROM: "Rollo <rollo@juanifraga.com>" } });
      expect(res.status).toBe(204);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.auth).toBe("Bearer re_test");
    expect(calls[0]!.body).toMatchObject({ from: "Rollo <rollo@juanifraga.com>", to: [email] });
    expect(calls[0]!.body.subject).toMatch(/^Tu código de Rollo: [ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(devSentCodes.has(email)).toBe(false);
  });
});

describe("POST /auth/email/verify", () => {
  it("signs in a new user: token, user without name, isNew", async () => {
    const email = "feliz@rollo.test";
    const code = await requestCode(email);
    const res = await verify(email, code);
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.isNew).toBe(true);
    expect(res.body.user).toEqual({ id: expect.any(String), email, name: null, username: null, avatarUrl: null, bio: null, badge: null, profileVisibility: "friends" });

    expect((await api("GET", "/me", { token: res.body.token })).status).toBe(200);
  });

  it("only stores the hash of the session token", async () => {
    const { token } = await signUp();
    const rows = await env.DB.prepare("SELECT token_hash FROM sessions").all<{ token_hash: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.token_hash).not.toBe(token);
    expect(rows.results[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an existing user signs in again: same user, isNew false once they have a name", async () => {
    const first = await signUp("vuelve@rollo.test", "Fede");
    await ageCodes("vuelve@rollo.test", 2 * MINUTE);
    const code = await requestCode("vuelve@rollo.test");
    const res = await verify("vuelve@rollo.test", code);
    expect(res.status).toBe(200);
    expect(res.body.isNew).toBe(false);
    expect(res.body.user).toMatchObject({ id: first.userId, name: "Fede" });
    expect(res.body.token).not.toBe(first.token);
    // Both sessions work.
    expect((await api("GET", "/me", { token: first.token })).status).toBe(200);
    expect((await api("GET", "/me", { token: res.body.token })).status).toBe(200);
  });

  it("isNew stays true until the user sets a name", async () => {
    const email = "sinnombre@rollo.test";
    const first = await verify(email, await requestCode(email));
    await ageCodes(email, 2 * MINUTE);
    const second = await verify(email, await requestCode(email));
    expect(second.body.isNew).toBe(true);
    expect(second.body.user.id).toBe(first.body.user.id);
  });

  it("rejects a wrong code", async () => {
    const email = "mal@rollo.test";
    const code = await requestCode(email);
    const res = await verify(email, wrongCode(code));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Código incorrecto" });
    // The right code still works afterwards.
    expect((await verify(email, code)).status).toBe(200);
  });

  it("blocks the code after 5 wrong attempts, even the right one", async () => {
    const email = "bloqueo@rollo.test";
    const code = await requestCode(email);
    for (let i = 0; i < 5; i++) {
      expect((await verify(email, wrongCode(code))).body).toEqual({ error: "Código incorrecto" });
    }
    const res = await verify(email, code);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "El código venció, pedí uno nuevo" });
  });

  it("concurrent wrong guesses can't bypass the attempt limit", async () => {
    const email = "carrera@rollo.test";
    const code = await requestCode(email);
    const results = await Promise.all(Array.from({ length: 10 }, () => verify(email, wrongCode(code))));
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(results.filter((r) => r.body.error === "Código incorrecto").length).toBeLessThanOrEqual(5);

    const row = await env.DB.prepare("SELECT attempts FROM auth_codes WHERE email = ?").bind(email).first<{ attempts: number }>();
    expect(row!.attempts).toBe(5);
    const res = await verify(email, code);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "El código venció, pedí uno nuevo" });
  });

  it("concurrent correct verifies create a single session", async () => {
    const email = "doble@rollo.test";
    const code = await requestCode(email);
    const results = await Promise.all(Array.from({ length: 3 }, () => verify(email, code)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(2);
    const { results: sessions } = await env.DB.prepare("SELECT id FROM sessions").all();
    expect(sessions).toHaveLength(1);
  });

  it("rejects an expired code", async () => {
    const email = "vencido@rollo.test";
    const code = await requestCode(email);
    await ageCodes(email, 6 * MINUTE);
    const res = await verify(email, code);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "El código venció, pedí uno nuevo" });
  });

  it("accepts a code just before it expires", async () => {
    const email = "justo@rollo.test";
    const code = await requestCode(email);
    await ageCodes(email, 4 * MINUTE);
    expect((await verify(email, code)).status).toBe(200);
  });

  it("expires exactly 5 minutes after it was issued", async () => {
    const email = "cinco@rollo.test";
    await requestCode(email);
    const row = await env.DB.prepare("SELECT created_at, expires_at FROM auth_codes WHERE email = ?").bind(email).first<{ created_at: number; expires_at: number }>();
    expect(row!.expires_at - row!.created_at).toBe(5 * MINUTE);
  });

  it("accepts lowercase, spaces and dashes in the code", async () => {
    for (const [i, fmt] of [(c: string) => c.toLowerCase(), (c: string) => ` ${c.slice(0, 3)}-${c.slice(3)} `, (c: string) => c.toLowerCase().split("").join(" ")].entries()) {
      const email = `formato${i}@rollo.test`;
      const code = await requestCode(email);
      expect((await verify(email, fmt(code))).status, email).toBe(200);
    }
  });

  it("rejects malformed codes as incorrect without using up an attempt", async () => {
    const email = "malformado@rollo.test";
    const code = await requestCode(email);
    for (const bad of ["", "   ", "AB$CD2", "A".repeat(16)]) {
      const res = await verify(email, bad);
      expect(res.status, bad).toBe(400);
      expect(res.body, bad).toEqual({ error: "Código incorrecto" });
    }
    const row = await env.DB.prepare("SELECT attempts FROM auth_codes WHERE email = ?").bind(email).first<{ attempts: number }>();
    expect(row!.attempts).toBe(0);
    expect((await verify(email, code)).status).toBe(200);
  });

  it("a code can only be used once", async () => {
    const email = "uso@rollo.test";
    const code = await requestCode(email);
    expect((await verify(email, code)).status).toBe(200);
    const again = await verify(email, code);
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: "El código venció, pedí uno nuevo" });
  });

  it("a new code invalidates the previous one", async () => {
    const email = "nuevo-codigo@rollo.test";
    const old = await requestCode(email);
    await ageCodes(email, 2 * MINUTE);
    let fresh = await requestCode(email);
    // Extremely unlikely, but keep the assertion meaningful if the two codes collide.
    while (fresh === old) {
      await ageCodes(email, 2 * MINUTE);
      fresh = await requestCode(email);
    }
    const res = await verify(email, old);
    expect(res.status).toBe(400);
    expect((await verify(email, fresh)).status).toBe(200);
  });

  it("fails without a code request", async () => {
    const res = await verify("nadie@rollo.test", "ABC234");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "El código venció, pedí uno nuevo" });
  });

  it("a code is bound to its email", async () => {
    const code = await requestCode("a@rollo.test");
    await requestCode("b@rollo.test");
    expect((await verify("b@rollo.test", code)).status).toBe(code === devSentCodes.get("b@rollo.test") ? 200 : 400);
  });

  it("normalises the email on both calls (case and spaces)", async () => {
    const code = await requestCode("Mixto@Rollo.Test");
    const res = await verify("  MIXTO@rollo.test ", code);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("mixto@rollo.test");

    // Same user, not a duplicate, when signing in with another capitalisation.
    await ageCodes("mixto@rollo.test", 2 * MINUTE);
    const again = await verify("mixto@ROLLO.test", await requestCode("mixto@rollo.test"));
    expect(again.body.user.id).toBe(res.body.user.id);
    const { results } = await env.DB.prepare("SELECT id FROM users").all();
    expect(results).toHaveLength(1);
  });
});

describe("App Review account", () => {
  const review = { REVIEW_EMAIL: "Review@Rollo.test", REVIEW_CODE: "K7M2QX" };

  it("start sends nothing and verify accepts the fixed code", async () => {
    const email = "review@rollo.test";
    const started = await start(email, { env: review });
    expect(started.status).toBe(204);
    expect(devSentCodes.has(email)).toBe(false);

    const res = await api("POST", "/auth/email/verify", { body: { email, code: "K7M2QX" }, env: review });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
  });

  it("doesn't send email through Resend either", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("{}");
    }) as typeof fetch;
    try {
      const res = await start("review@rollo.test", { env: { ...review, RESEND_API_KEY: "re_test" } });
      expect(res.status).toBe(204);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toBe(0);
  });

  it("still enforces attempts and rate limits", async () => {
    const email = "review@rollo.test";
    await start(email, { env: review });
    expect((await start(email, { env: review })).status).toBe(429);

    for (let i = 0; i < 5; i++) {
      const res = await api("POST", "/auth/email/verify", { body: { email, code: "AAAAAA" }, env: review });
      expect(res.body).toEqual({ error: "Código incorrecto" });
    }
    const blocked = await api("POST", "/auth/email/verify", { body: { email, code: "K7M2QX" }, env: review });
    expect(blocked.status).toBe(400);
  });

  it("accepts the review code in lowercase", async () => {
    const email = "review@rollo.test";
    await start(email, { env: review });
    const res = await api("POST", "/auth/email/verify", { body: { email, code: " k7m-2qx " }, env: review });
    expect(res.status).toBe(200);
  });

  it("other emails still get random codes", async () => {
    const email = "otro@rollo.test";
    await start(email, { env: review });
    const code = devSentCodes.get(email);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    const res = await api("POST", "/auth/email/verify", { body: { email, code: "K7M2QX" }, env: review });
    expect(res.status).toBe(code === "K7M2QX" ? 200 : 400);
  });

  it("without the variables there is no review account", async () => {
    const email = "review@rollo.test";
    await start(email);
    expect(devSentCodes.get(email)).toBeDefined();
    expect((await verify(email, "K7M2QX")).status).toBe(devSentCodes.get(email) === "K7M2QX" ? 200 : 400);
  });
});

describe("POST /auth/logout", () => {
  it("deletes the current session only", async () => {
    const a = await signUp("dos@rollo.test", "Fede");
    await ageCodes("dos@rollo.test", 2 * MINUTE);
    const b = await verify("dos@rollo.test", await requestCode("dos@rollo.test"));

    const res = await api("POST", "/auth/logout", { token: a.token });
    expect(res.status).toBe(204);
    expect((await api("GET", "/me", { token: a.token })).status).toBe(401);
    expect((await api("GET", "/me", { token: b.body.token })).status).toBe(200);
  });

  it("requires a session", async () => {
    expect((await api("POST", "/auth/logout")).status).toBe(401);
  });
});

describe("sessions", () => {
  it("a missing token gives 401 'Falta el token'", async () => {
    const res = await api("GET", "/me");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Falta el token" });
  });

  it("an unknown token gives 401 'Sesión inválida'", async () => {
    const res = await api("GET", "/me", { token: "inventado" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Sesión inválida, volvé a entrar" });
  });

  it("an expired session gives 401", async () => {
    const { token } = await signUp();
    await env.DB.prepare("UPDATE sessions SET expires_at = ?").bind(Date.now() - 1000).run();
    expect((await api("GET", "/me", { token })).status).toBe(401);
  });

  it("sessions last about a year", async () => {
    await signUp();
    const row = await env.DB.prepare("SELECT created_at, expires_at FROM sessions").first<{ created_at: number; expires_at: number }>();
    expect(row!.expires_at - row!.created_at).toBe(365 * 24 * HOUR);
  });

  it("using the session extends it another year, at most once per day", async () => {
    const { token } = await signUp();
    const read = async () => (await env.DB.prepare("SELECT expires_at FROM sessions").first<{ expires_at: number }>())!.expires_at;

    // Used 10 minutes ago: nothing changes yet.
    const nearExpiry = Date.now() + 2 * 24 * HOUR;
    await env.DB.prepare("UPDATE sessions SET expires_at = ?, last_used_at = ?").bind(nearExpiry, Date.now() - 10 * MINUTE).run();
    await api("GET", "/me", { token });
    expect(await read()).toBe(nearExpiry);

    // Used 2 days ago and about to expire: it goes back to a full year from now.
    await env.DB.prepare("UPDATE sessions SET last_used_at = ?").bind(Date.now() - 2 * DAY).run();
    const before = Date.now();
    expect((await api("GET", "/me", { token })).status).toBe(200);
    expect(await read()).toBeGreaterThanOrEqual(before + 365 * 24 * HOUR);
  });

  it("last_used_at is refreshed, but at most once per day", async () => {
    const { token } = await signUp();
    const read = async () => (await env.DB.prepare("SELECT last_used_at FROM sessions").first<{ last_used_at: number }>())!.last_used_at;

    const recent = Date.now() - 10 * MINUTE;
    await env.DB.prepare("UPDATE sessions SET last_used_at = ?").bind(recent).run();
    await api("GET", "/me", { token });
    expect(await read()).toBe(recent);

    const stale = Date.now() - 2 * DAY;
    await env.DB.prepare("UPDATE sessions SET last_used_at = ?").bind(stale).run();
    await api("GET", "/me", { token });
    expect(await read()).toBeGreaterThan(stale + DAY);
  });
});
