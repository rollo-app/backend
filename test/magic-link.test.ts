import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { devSentCodes, devSentLinks } from "../src/infra/dev/dev-mailer";
import { api, MINUTE } from "./helpers";

const LINK_ERROR = { error: "El link venció o ya se usó. Pedí otro código." };

const verifyLink = (email: string, token: string, verifier?: string) =>
  api("POST", "/auth/email/verify-link", { body: { email, token, ...(verifier !== undefined && { verifier }) } });
const verifyCode = (email: string, code: string) => api("POST", "/auth/email/verify", { body: { email, code } });

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A fresh PKCE-style verifier, as the app keeps it on the phone: 32 random bytes in base64url (43 chars). */
function newVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** base64url(SHA-256(verifier)): what the app sends to /start. */
async function challengeOf(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/**
 * Calls start with a link challenge (like the app does) and returns the code, the magic-link token that
 * "were emailed" and the verifier the phone kept.
 */
async function requestLogin(email: string, extraEnv?: Record<string, unknown>) {
  devSentCodes.delete(email);
  devSentLinks.delete(email);
  const verifier = newVerifier();
  const linkChallenge = await challengeOf(verifier);
  const res = await api("POST", "/auth/email/start", { body: { email, linkChallenge }, ...(extraEnv && { env: extraEnv }) });
  if (res.status !== 204) throw new Error(`start failed: ${res.status} ${JSON.stringify(res.body)}`);
  const url = devSentLinks.get(email)!;
  const token = new URLSearchParams(url.split("#")[1]).get("t")!;
  return { code: devSentCodes.get(email)!, url, token, verifier };
}

/** Intercepts the Resend call of /start and returns the email that would have been sent. */
async function captureResendEmail(body: Record<string, unknown>) {
  const realFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    expect((await api("POST", "/auth/email/start", { body, env: { RESEND_API_KEY: "re_test" } })).status).toBe(204);
  } finally {
    globalThis.fetch = realFetch;
  }
  return bodies[0]! as { subject: string; text: string; html: string };
}

async function ageCodes(email: string, ms: number) {
  await env.DB.prepare("UPDATE auth_codes SET created_at = created_at - ?, expires_at = expires_at - ? WHERE email = ?")
    .bind(ms, ms, email)
    .run();
}

const sessionCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n;

describe("magic link in the login email", () => {
  it("emails a link with the token and the email in the URL fragment", async () => {
    const email = "link+uno@rollo.test";
    const { url, token } = await requestLogin(email);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(url).toBe(`https://rollo.juanifraga.com/entrar#t=${token}&e=${encodeURIComponent(email)}`);
  });

  it("uses LOGIN_LINK_URL as the base of the link", async () => {
    const email = "base@rollo.test";
    const { url, token } = await requestLogin(email, { LOGIN_LINK_URL: "https://staging.rollo.test/entrar" });
    expect(url).toBe(`https://staging.rollo.test/entrar#t=${token}&e=${encodeURIComponent(email)}`);
  });

  it("stores only a hash of the token", async () => {
    const email = "hashlink@rollo.test";
    const { token } = await requestLogin(email);
    const row = await env.DB.prepare("SELECT link_hash FROM auth_codes WHERE email = ?").bind(email).first<{ link_hash: string }>();
    expect(row!.link_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.link_hash).not.toContain(token);
  });

  it("puts the code and the link in the email sent through Resend", async () => {
    const email = "mail@rollo.test";
    const { subject, text, html } = await captureResendEmail({ email, linkChallenge: await challengeOf(newVerifier()) });
    const code = subject.match(/([A-Z0-9]{6})$/)![1]!;
    const url = text.match(/(https:\/\/rollo\.juanifraga\.com\/entrar#t=[A-Za-z0-9_-]+&e=mail%40rollo\.test)/)?.[1];
    expect(url).toBeDefined();
    expect(text).toContain(`Tu código de Rollo es ${code}`);
    expect(text).toContain(`O tocá este link desde tu iPhone: ${url}`);
    expect(html).toContain(code);
    expect(html).toContain(`href="${url!.replace("&", "&amp;")}"`);
    expect(html).toContain("Abrir Rollo");
  });
});

describe("POST /auth/email/start with a link challenge", () => {
  it("without a challenge (old app builds) sends only the code: no link in the email", async () => {
    const email = "viejo@rollo.test";
    devSentLinks.delete(email);
    devSentCodes.delete(email);
    expect((await api("POST", "/auth/email/start", { body: { email } })).status).toBe(204);
    expect(devSentCodes.get(email)).toMatch(/^[A-Z0-9]{6}$/);
    expect(devSentLinks.has(email)).toBe(false);
    const row = await env.DB.prepare("SELECT link_hash, link_challenge FROM auth_codes WHERE email = ?")
      .bind(email)
      .first<{ link_hash: string | null; link_challenge: string | null }>();
    expect(row).toEqual({ link_hash: null, link_challenge: null });
  });

  it("the Resend email without a challenge has the code but no button and no link line", async () => {
    const email = "viejo-mail@rollo.test";
    const { subject, text, html } = await captureResendEmail({ email });
    const code = subject.match(/([A-Z0-9]{6})$/)![1]!;
    expect(text).toContain(`Tu código de Rollo es ${code}`);
    expect(html).toContain(code);
    expect(text).not.toContain("http");
    expect(text).not.toContain("link");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("Abrir Rollo");
  });

  it("without a challenge verify-link always fails, and the code still works", async () => {
    const email = "sin-link@rollo.test";
    devSentCodes.delete(email);
    await api("POST", "/auth/email/start", { body: { email } });
    const verifier = newVerifier();
    for (const token of [newVerifier(), "A".repeat(43)]) {
      expect((await verifyLink(email, token, verifier)).body).toEqual(LINK_ERROR);
    }
    expect((await verifyCode(email, devSentCodes.get(email)!)).status).toBe(200);
  });

  it("stores the challenge as sent", async () => {
    const email = "guarda-challenge@rollo.test";
    const challenge = await challengeOf(newVerifier());
    expect((await api("POST", "/auth/email/start", { body: { email, linkChallenge: challenge } })).status).toBe(204);
    const row = await env.DB.prepare("SELECT link_challenge FROM auth_codes WHERE email = ?").bind(email).first<{ link_challenge: string }>();
    expect(row!.link_challenge).toBe(challenge);
  });

  it("rejects a malformed challenge with 400 and sends nothing", async () => {
    const email = "challenge-raro@rollo.test";
    for (const bad of ["", "corto", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, `${"A".repeat(42)}+`, "a".repeat(200), 123]) {
      devSentCodes.delete(email);
      const res = await api("POST", "/auth/email/start", { body: { email, linkChallenge: bad } });
      expect(res.status, String(bad)).toBe(400);
      expect(devSentCodes.has(email), String(bad)).toBe(false);
    }
  });
});

describe("POST /auth/email/verify-link", () => {
  it("signs in with the link and the phone's verifier: token, user and isNew, like the code", async () => {
    const email = "entra@rollo.test";
    const { token, verifier } = await requestLogin(email);
    const res = await verifyLink(email, token, verifier);
    expect(res.status).toBe(200);
    expect(res.body.isNew).toBe(true);
    expect(res.body.user).toMatchObject({ email, name: null });
    expect((await api("GET", "/me", { token: res.body.token })).status).toBe(200);
  });

  it("rejects the link without the verifier (another phone or app opened it)", async () => {
    const email = "sin-verifier@rollo.test";
    const { token, verifier } = await requestLogin(email);
    const res = await verifyLink(email, token);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(LINK_ERROR);
    expect(await sessionCount()).toBe(0);
    // It counted as a failed attempt but the right phone can still use it.
    const row = await env.DB.prepare("SELECT attempts FROM auth_codes WHERE email = ?").bind(email).first<{ attempts: number }>();
    expect(row!.attempts).toBe(1);
    expect((await verifyLink(email, token, verifier)).status).toBe(200);
  });

  it("rejects the link with a wrong verifier (login CSRF: attacker's link opened on the victim's phone)", async () => {
    const email = "atacante@rollo.test";
    const { token, verifier } = await requestLogin(email);
    const victimsVerifier = newVerifier();
    const res = await verifyLink(email, token, victimsVerifier);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(LINK_ERROR);
    expect(await sessionCount()).toBe(0);
    expect((await verifyLink(email, token, verifier)).status).toBe(200);
  });

  it("the right verifier does not help with a wrong token", async () => {
    const email = "token-malo@rollo.test";
    const { token, verifier } = await requestLogin(email);
    expect((await verifyLink(email, newVerifier(), verifier)).body).toEqual(LINK_ERROR);
    expect((await verifyLink(email, token, verifier)).status).toBe(200);
  });

  it("rejects malformed verifiers with the same error, counting them as attempts", async () => {
    const email = "verifier-raro@rollo.test";
    const { token, verifier } = await requestLogin(email);
    for (const bad of ["", "corto", "con espacios y $ímbolos"]) {
      const res = await verifyLink(email, token, bad);
      expect(res.status, bad).toBe(400);
      expect(res.body, bad).toEqual(LINK_ERROR);
    }
    const row = await env.DB.prepare("SELECT attempts FROM auth_codes WHERE email = ?").bind(email).first<{ attempts: number }>();
    expect(row!.attempts).toBe(3);
    expect((await verifyLink(email, token, verifier)).status).toBe(200);
  });

  it("counts wrong verifiers as attempts: after 5 the link and the code are dead", async () => {
    const email = "fuerza-verifier@rollo.test";
    const { code, token, verifier } = await requestLogin(email);
    for (let i = 0; i < 5; i++) {
      expect((await verifyLink(email, token, newVerifier())).body).toEqual(LINK_ERROR);
    }
    expect((await verifyLink(email, token, verifier)).body).toEqual(LINK_ERROR);
    expect((await verifyCode(email, code)).status).toBe(400);
  });

  it("works only once", async () => {
    const email = "unavez@rollo.test";
    const { token, verifier } = await requestLogin(email);
    expect((await verifyLink(email, token, verifier)).status).toBe(200);
    const again = await verifyLink(email, token, verifier);
    expect(again.status).toBe(400);
    expect(again.body).toEqual(LINK_ERROR);
  });

  it("the code stops working after the link was used", async () => {
    const email = "linkcodigo@rollo.test";
    const { code, token, verifier } = await requestLogin(email);
    expect((await verifyLink(email, token, verifier)).status).toBe(200);
    expect((await verifyCode(email, code)).status).toBe(400);
  });

  it("the link stops working after the code was used", async () => {
    const email = "codigolink@rollo.test";
    const { code, token, verifier } = await requestLogin(email);
    expect((await verifyCode(email, code)).status).toBe(200);
    const res = await verifyLink(email, token, verifier);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(LINK_ERROR);
  });

  it("a new code request invalidates the previous link", async () => {
    const email = "nuevo-link@rollo.test";
    const first = await requestLogin(email);
    await ageCodes(email, 2 * MINUTE);
    const second = await requestLogin(email);
    expect((await verifyLink(email, first.token, first.verifier)).body).toEqual(LINK_ERROR);
    expect((await verifyLink(email, second.token, second.verifier)).status).toBe(200);
  });

  it("rejects an expired link", async () => {
    const email = "linkvencido@rollo.test";
    const { token, verifier } = await requestLogin(email);
    await ageCodes(email, 6 * MINUTE);
    const res = await verifyLink(email, token, verifier);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(LINK_ERROR);
  });

  it("rejects the link with another email", async () => {
    const a = "duena@rollo.test";
    const b = "otra@rollo.test";
    const { token, verifier } = await requestLogin(a);
    await requestLogin(b);
    const res = await verifyLink(b, token, verifier);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(LINK_ERROR);
    expect((await verifyLink("nadie@rollo.test", token, verifier)).body).toEqual(LINK_ERROR);
    // The owner's link still works.
    expect((await verifyLink(a, token, verifier)).status).toBe(200);
  });

  it("counts wrong tokens as attempts: after 5 the link and the code are dead", async () => {
    const email = "fuerza@rollo.test";
    const { code, token, verifier } = await requestLogin(email);
    const wrong = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    for (let i = 0; i < 5; i++) {
      expect((await verifyLink(email, wrong, verifier)).body).toEqual(LINK_ERROR);
    }
    expect((await verifyLink(email, token, verifier)).body).toEqual(LINK_ERROR);
    expect((await verifyCode(email, code)).status).toBe(400);
  });

  it("rejects malformed tokens with the same error", async () => {
    const email = "raro@rollo.test";
    const { token, verifier } = await requestLogin(email);
    for (const bad of ["", "corto", "a".repeat(200), "con espacios y $ímbolos que no van en base64url"]) {
      const res = await verifyLink(email, bad, verifier);
      expect(res.status, bad).toBe(400);
      expect(res.body, bad).toEqual(LINK_ERROR);
    }
    expect((await verifyLink(email, token, verifier)).status).toBe(200);
  });

  it("a double tap creates a single session", async () => {
    const email = "doble-tap@rollo.test";
    const { token, verifier } = await requestLogin(email);
    const results = await Promise.all(Array.from({ length: 3 }, () => verifyLink(email, token, verifier)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(2);
    expect(await sessionCount()).toBe(1);
  });

  it("normalises the email (case and spaces)", async () => {
    const { token, verifier } = await requestLogin("mayus@rollo.test");
    expect((await verifyLink("  Mayus@Rollo.TEST ", token, verifier)).status).toBe(200);
  });

  it("never accepts the token via GET", async () => {
    const email = "get@rollo.test";
    const { token, verifier } = await requestLogin(email);
    const res = await api("GET", `/auth/email/verify-link?email=${encodeURIComponent(email)}&token=${token}&verifier=${verifier}`);
    expect(res.status).not.toBe(200);
    expect(await sessionCount()).toBe(0);
    expect((await verifyLink(email, token, verifier)).status).toBe(200);
  });
});
