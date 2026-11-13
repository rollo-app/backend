import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEGRADED_MESSAGE, resetDegradedCache } from "../src/lib/degraded";
import { GOOGLE_ERROR, GOOGLE_UNAVAILABLE, setGoogleKeysForTests } from "../src/lib/google";
import { USE_EMAIL_CODE } from "../src/modules/auth/auth.service";
import { REGISTRATIONS_CLOSED_MESSAGE, resetRegistrationsCache } from "../src/lib/registrations";
import { api, closeRegistrations, signUp } from "./helpers";

// Audiences come from GOOGLE_CLIENT_IDS in vitest.config.ts.
const WEB_CLIENT = "test-web.apps.googleusercontent.com";
const IOS_CLIENT = "test-ios.apps.googleusercontent.com";

let signingKey: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  setGoogleKeysForTests(createLocalJWKSet({ keys: [jwk] }));
});
afterAll(() => setGoogleKeysForTests(null));
beforeEach(() => {
  resetDegradedCache();
  resetRegistrationsCache();
});

let subCounter = 0;

/** A Google ID token like the one the app gets from Google Sign-In. */
async function googleToken(
  claims: JWTPayload & { email?: string; email_verified?: boolean; name?: string; hd?: string } = {},
  opts: { key?: CryptoKey; expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT({ email: `g${subCounter}@gmail.com`, email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer((claims.iss as string) ?? "https://accounts.google.com")
    .setAudience((claims.aud as string) ?? WEB_CLIENT)
    .setSubject((claims.sub as string) ?? `google-${++subCounter}`)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h")
    .sign(opts.key ?? signingKey);
}

const signInWithGoogle = (idToken: string) => api("POST", "/auth/google", { body: { idToken } });

describe("POST /auth/google", () => {
  it("creates the account on the first sign-in and returns a working session", async () => {
    const res = await signInWithGoogle(await googleToken({ sub: "g-new", email: "Nueva@Gmail.com" }));
    expect(res.status).toBe(200);
    expect(res.body.isNew).toBe(true);
    expect(res.body.user.email).toBe("nueva@gmail.com");
    const me = await api("GET", "/me", { token: res.body.token });
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(res.body.user.id);
  });

  it("signs an existing email account into the same user and links it", async () => {
    const existing = await signUp("cami@gmail.com");
    const res = await signInWithGoogle(await googleToken({ sub: "g-cami", email: "cami@gmail.com" }));
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(existing.userId);
    expect(res.body.isNew).toBe(false);
    const link = await env.DB.prepare("SELECT user_id FROM user_identities WHERE provider = 'google' AND subject = 'g-cami'").first();
    expect(link?.user_id).toBe(existing.userId);
  });

  it("a non-Google email that already has an account is not linked (Google only checked it once): 409, use the code", async () => {
    const existing = await signUp("cami@hotmail.com");
    const res = await signInWithGoogle(await googleToken({ sub: "g-hot", email: "cami@hotmail.com" }));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(USE_EMAIL_CODE);
    const link = await env.DB.prepare("SELECT 1 FROM user_identities WHERE subject = 'g-hot'").first();
    expect(link).toBeNull();
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(existing.userId).first<{ n: number }>())!;
    expect(n).toBe(1);
  });

  it("a Google Workspace email (hd matches its domain) links an existing account", async () => {
    const existing = await signUp("juani@empresa.com");
    const res = await signInWithGoogle(await googleToken({ email: "juani@empresa.com", hd: "empresa.com" }));
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(existing.userId);
  });

  it("a non-Google email without an account still signs up", async () => {
    const res = await signInWithGoogle(await googleToken({ email: "nueva@hotmail.com" }));
    expect(res.status).toBe(200);
    expect(res.body.isNew).toBe(true);
  });

  it("finds the user by the Google account id even if its email changed", async () => {
    const first = await signInWithGoogle(await googleToken({ sub: "g-same", email: "viejo@gmail.com" }));
    const again = await signInWithGoogle(await googleToken({ sub: "g-same", email: "nuevo@gmail.com" }));
    expect(again.status).toBe(200);
    expect(again.body.user.id).toBe(first.body.user.id);
    expect(again.body.user.email).toBe("viejo@gmail.com");
  });

  it("a new account starts with the Google name, to prefill the profile step (still incomplete without a username)", async () => {
    const res = await signInWithGoogle(await googleToken({ email: "lu@gmail.com", name: "  Lucía   Pérez " }));
    expect(res.body.user.name).toBe("Lucía Pérez");
    expect(res.body.isNew).toBe(true);
    const row = await env.DB.prepare("SELECT name_search FROM users WHERE email = 'lu@gmail.com'").first();
    expect(row?.name_search).toBe(" lucia perez");
  });

  it("cuts a Google name longer than a profile name allows, and ignores an empty one", async () => {
    const long = await signInWithGoogle(await googleToken({ email: "largo@gmail.com", name: "Juan Ignacio Fraga de la Torre Gonzalez" }));
    expect(long.body.user.name).toBe("Juan Ignacio Fraga de la Torre");
    const empty = await signInWithGoogle(await googleToken({ email: "vacio@gmail.com", name: "   " }));
    expect(empty.body.user.name).toBeNull();
  });

  it("never overwrites the name of an existing account; fills it only if it had none", async () => {
    await signUp("cami@gmail.com", "Cami");
    const named = await signInWithGoogle(await googleToken({ email: "cami@gmail.com", name: "Camila Gómez" }));
    expect(named.body.user.name).toBe("Cami");
    await signUp("rocio@gmail.com", null, null);
    const unnamed = await signInWithGoogle(await googleToken({ email: "rocio@gmail.com", name: "Rocío" }));
    expect(unnamed.body.user.name).toBe("Rocío");
  });

  it("accepts every configured client id as audience", async () => {
    expect((await signInWithGoogle(await googleToken({ aud: IOS_CLIENT }))).status).toBe(200);
  });

  it("rejects an email Google did not verify", async () => {
    const res = await signInWithGoogle(await googleToken({ email_verified: false }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(GOOGLE_ERROR);
  });

  it("rejects tokens for another app, from another issuer, expired, signed with another key or malformed", async () => {
    const bad = [
      await googleToken({ aud: "otra-app.apps.googleusercontent.com" }),
      await googleToken({ iss: "https://evil.example.com" }),
      await googleToken({}, { expiresIn: "-10m" }),
      await googleToken({}, { key: otherKey }),
      "no-es-un-token",
    ];
    for (const idToken of bad) {
      const res = await signInWithGoogle(idToken);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(GOOGLE_ERROR);
    }
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it("answers 503 when no client id is configured", async () => {
    const res = await api("POST", "/auth/google", { body: { idToken: await googleToken() }, env: { GOOGLE_CLIENT_IDS: "" } });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(GOOGLE_UNAVAILABLE);
  });

  it("in degraded mode, existing accounts still get in and new ones get 503", async () => {
    await signUp("ana@gmail.com");
    await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('degraded_mode', '1', 0)").run();
    resetDegradedCache();
    expect((await signInWithGoogle(await googleToken({ email: "ana@gmail.com" }))).status).toBe(200);
    const fresh = await signInWithGoogle(await googleToken({ email: "nadie@gmail.com" }));
    expect(fresh.status).toBe(503);
    expect(fresh.body.error).toBe(DEGRADED_MESSAGE);
  });

  it("deleting the account removes the Google link: signing in again creates a new account", async () => {
    const first = await signInWithGoogle(await googleToken({ sub: "g-bye", email: "chau@gmail.com" }));
    expect((await api("DELETE", "/me", { token: first.body.token })).status).toBe(204);
    const again = await signInWithGoogle(await googleToken({ sub: "g-bye", email: "chau@gmail.com" }));
    expect(again.status).toBe(200);
    expect(again.body.user.id).not.toBe(first.body.user.id);
    expect(again.body.isNew).toBe(true);
  });
});

describe("closed registrations", () => {
  it("a new account gets 403 with the code; an existing email account and a linked identity still get in", async () => {
    const existing = await signUp("ana@gmail.com");
    const linked = await signInWithGoogle(await googleToken({ sub: "g-linked", email: "linkeada@gmail.com" }));
    expect(linked.status).toBe(200);
    await closeRegistrations();

    const fresh = await signInWithGoogle(await googleToken({ sub: "g-fresh", email: "nadie@gmail.com" }));
    expect(fresh.status).toBe(403);
    expect(fresh.body).toEqual({ error: REGISTRATIONS_CLOSED_MESSAGE, code: "REGISTRATIONS_CLOSED" });
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE email = 'nadie@gmail.com'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM user_identities WHERE subject = 'g-fresh'").first()).toBeNull();

    const byEmail = await signInWithGoogle(await googleToken({ sub: "g-ana", email: "ana@gmail.com" }));
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.user.id).toBe(existing.userId);
    const bySub = await signInWithGoogle(await googleToken({ sub: "g-linked", email: "otro-mail@gmail.com" }));
    expect(bySub.status).toBe(200);
    expect(bySub.body.user.id).toBe(linked.body.user.id);
  });
});
