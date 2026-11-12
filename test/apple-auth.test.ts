import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEGRADED_MESSAGE, resetDegradedCache } from "../src/lib/degraded";
import { APPLE_ERROR, APPLE_UNAVAILABLE, setAppleKeysForTests } from "../src/lib/apple";
import { USE_EMAIL_CODE } from "../src/modules/auth/auth.service";
import { REGISTRATIONS_CLOSED_MESSAGE, resetRegistrationsCache } from "../src/lib/registrations";
import { api, closeRegistrations, signUp } from "./helpers";

// Audiences come from APPLE_CLIENT_IDS in vitest.config.ts.
const PROD_APP = "com.juanifraga.rollo.app";

let signingKey: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "apple-test-key", alg: "RS256", use: "sig" };
  setAppleKeysForTests(createLocalJWKSet({ keys: [jwk] }));
});
afterAll(() => setAppleKeysForTests(null));
beforeEach(() => {
  resetDegradedCache();
  resetRegistrationsCache();
});

let subCounter = 0;

/** An Apple identity token like the one the app gets from Sign in with Apple (Apple sends email_verified as a string). */
async function appleToken(
  claims: JWTPayload & { email?: string | null; email_verified?: boolean | string } = {},
  opts: { key?: CryptoKey; expiresIn?: string } = {},
): Promise<string> {
  const { email = `a${subCounter}@icloud.com`, ...rest } = claims;
  return new SignJWT({ email_verified: "true", ...rest, ...(email === null ? {} : { email }) })
    .setProtectedHeader({ alg: "RS256", kid: "apple-test-key" })
    .setIssuer((claims.iss as string) ?? "https://appleid.apple.com")
    .setAudience((claims.aud as string) ?? PROD_APP)
    .setSubject((claims.sub as string) ?? `apple-${++subCounter}`)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "10m")
    .sign(opts.key ?? signingKey);
}

const signInWithApple = (body: { identityToken: string; name?: string }) => api("POST", "/auth/apple", { body });

describe("POST /auth/apple", () => {
  it("creates the account with the name the app got from Apple (only sent the first time)", async () => {
    const res = await signInWithApple({ identityToken: await appleToken({ sub: "a-new", email: "Nueva@iCloud.com" }), name: "  Lucía  Pérez " });
    expect(res.status).toBe(200);
    expect(res.body.isNew).toBe(true);
    expect(res.body.user.email).toBe("nueva@icloud.com");
    expect(res.body.user.name).toBe("Lucía Pérez");
    expect((await api("GET", "/me", { token: res.body.token })).status).toBe(200);
  });

  it("works with Hide My Email: the relay address is the account's email", async () => {
    const relay = "x7k2p9@privaterelay.appleid.com";
    const res = await signInWithApple({ identityToken: await appleToken({ email: relay, is_private_email: "true" }) });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(relay);
  });

  it("later sign-ins find the user by the Apple account id, without a name and even without an email", async () => {
    const first = await signInWithApple({ identityToken: await appleToken({ sub: "a-same", email: "uno@icloud.com" }), name: "Uno" });
    const again = await signInWithApple({ identityToken: await appleToken({ sub: "a-same", email: null }) });
    expect(again.status).toBe(200);
    expect(again.body.user.id).toBe(first.body.user.id);
    expect(again.body.user.name).toBe("Uno");
  });

  it("links an existing account when Apple owns the email (iCloud or its relay)", async () => {
    const existing = await signUp("cami@icloud.com", "Cami");
    const res = await signInWithApple({ identityToken: await appleToken({ sub: "a-cami", email: "cami@icloud.com" }), name: "Camila" });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(existing.userId);
    expect(res.body.user.name).toBe("Cami");
  });

  it("a non-Apple email that already has an account is not linked: 409, use the code", async () => {
    await signUp("cami@gmail.com");
    const res = await signInWithApple({ identityToken: await appleToken({ sub: "a-gmail", email: "cami@gmail.com" }) });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(USE_EMAIL_CODE);
    expect(await env.DB.prepare("SELECT 1 FROM user_identities WHERE subject = 'a-gmail'").first()).toBeNull();
  });

  it("a first sign-in without an email can't make an account", async () => {
    const res = await signInWithApple({ identityToken: await appleToken({ email: null }) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(APPLE_ERROR);
  });

  it("rejects tokens for another app, from another issuer, expired, signed with another key, unverified or malformed", async () => {
    const bad = [
      await appleToken({ aud: "com.otra.app" }),
      await appleToken({ iss: "https://evil.example.com" }),
      await appleToken({}, { expiresIn: "-10m" }),
      await appleToken({}, { key: otherKey }),
      await appleToken({ email_verified: "false" }),
      "no-es-un-token",
    ];
    for (const identityToken of bad) {
      const res = await signInWithApple({ identityToken });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(APPLE_ERROR);
    }
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it("answers 503 when no client id is configured", async () => {
    const res = await api("POST", "/auth/apple", { body: { identityToken: await appleToken() }, env: { APPLE_CLIENT_IDS: "" } });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(APPLE_UNAVAILABLE);
  });

  it("in degraded mode, existing accounts still get in and new ones get 503", async () => {
    await signUp("ana@icloud.com");
    await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('degraded_mode', '1', 0)").run();
    resetDegradedCache();
    expect((await signInWithApple({ identityToken: await appleToken({ email: "ana@icloud.com" }) })).status).toBe(200);
    const fresh = await signInWithApple({ identityToken: await appleToken({ email: "nadie@icloud.com" }) });
    expect(fresh.status).toBe(503);
    expect(fresh.body.error).toBe(DEGRADED_MESSAGE);
  });

  it("records the link to the Apple account", async () => {
    const apple = await signInWithApple({ identityToken: await appleToken({ sub: "a-both", email: "both@icloud.com" }) });
    const links = await env.DB.prepare("SELECT provider FROM user_identities WHERE user_id = ?").bind(apple.body.user.id).all();
    expect(links.results.map((r) => r.provider)).toEqual(["apple"]);
  });
});

describe("closed registrations", () => {
  it("a new account gets 403 with the code; an existing email account and a linked identity still get in", async () => {
    const existing = await signUp("ana@icloud.com");
    const linked = await signInWithApple({ identityToken: await appleToken({ sub: "a-linked", email: "linkeada@icloud.com" }) });
    expect(linked.status).toBe(200);
    await closeRegistrations();

    const fresh = await signInWithApple({ identityToken: await appleToken({ sub: "a-fresh", email: "nadie@icloud.com" }) });
    expect(fresh.status).toBe(403);
    expect(fresh.body).toEqual({ error: REGISTRATIONS_CLOSED_MESSAGE, code: "REGISTRATIONS_CLOSED" });
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE email = 'nadie@icloud.com'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM user_identities WHERE subject = 'a-fresh'").first()).toBeNull();

    const byEmail = await signInWithApple({ identityToken: await appleToken({ sub: "a-ana", email: "ana@icloud.com" }) });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.user.id).toBe(existing.userId);
    const bySub = await signInWithApple({ identityToken: await appleToken({ sub: "a-linked", email: "otro-mail@icloud.com" }) });
    expect(bySub.status).toBe(200);
    expect(bySub.body.user.id).toBe(linked.body.user.id);
  });
});
