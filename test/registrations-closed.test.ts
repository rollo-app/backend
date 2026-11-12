import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { devSentCodes, devSentLinks } from "../src/lib/email";
import { areRegistrationsOpen, REGISTRATIONS_CLOSED_MESSAGE, resetRegistrationsCache } from "../src/lib/registrations";
import { api, closeRegistrations, logIn, makeSuperadmin, requestCode, signUp } from "./helpers";

beforeEach(() => resetRegistrationsCache());

const CLOSED_BODY = { error: REGISTRATIONS_CLOSED_MESSAGE, code: "REGISTRATIONS_CLOSED" };
const userCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!.n;

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Like the app: start with a link challenge; returns the code, the link token and the verifier. */
async function requestLogin(email: string) {
  devSentCodes.delete(email);
  devSentLinks.delete(email);
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const linkChallenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const res = await api("POST", "/auth/email/start", { body: { email, linkChallenge } });
  expect(res.status).toBe(204);
  const token = new URLSearchParams(devSentLinks.get(email)!.split("#")[1]).get("t")!;
  return { code: devSentCodes.get(email)!, token, verifier };
}

describe("closed registrations: email code and magic link", () => {
  it("the message and code are the contract", () => {
    expect(REGISTRATIONS_CLOSED_MESSAGE).toBe("Por ahora no estamos sumando cuentas nuevas. Anotate en la lista y te avisamos cuando abramos.");
  });

  it("verifying the code for an email with no account answers 403 with the code and creates nothing", async () => {
    await closeRegistrations();
    const code = await requestCode("nueva@rollo.test");
    const res = await api("POST", "/auth/email/verify", { body: { email: "nueva@rollo.test", code } });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(CLOSED_BODY);
    expect(await userCount()).toBe(0);
  });

  it("a wrong code for an unknown email is still the plain 400 (no enumeration without owning the email)", async () => {
    await closeRegistrations();
    await requestCode("nueva@rollo.test");
    const res = await api("POST", "/auth/email/verify", { body: { email: "nueva@rollo.test", code: "AAAAAA" } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Código incorrecto" });
  });

  it("existing accounts log in normally, complete or not", async () => {
    const done = await signUp("ana@rollo.test");
    const incomplete = await signUp("beto@rollo.test", null, null);
    await closeRegistrations();
    const token = await logIn(done.email);
    expect((await api("GET", "/me", { token })).body.id).toBe(done.userId);
    const token2 = await logIn(incomplete.email);
    expect((await api("GET", "/me", { token: token2 })).status).toBe(200);
  });

  it("the magic link behaves the same: 403 for a new email, signs in an existing one", async () => {
    const existing = await signUp("ana@rollo.test");
    await closeRegistrations();
    const fresh = await requestLogin("nueva@rollo.test");
    const denied = await api("POST", "/auth/email/verify-link", { body: { email: "nueva@rollo.test", token: fresh.token, verifier: fresh.verifier } });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual(CLOSED_BODY);
    expect(await userCount()).toBe(1);

    await env.DB.prepare("UPDATE auth_codes SET created_at = created_at - 7200000 WHERE email = ?").bind(existing.email).run();
    const known = await requestLogin(existing.email);
    const ok = await api("POST", "/auth/email/verify-link", { body: { email: existing.email, token: known.token, verifier: known.verifier } });
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(existing.userId);
  });

  it("start answers the same for known and unknown emails, and still spends the new-user caps", async () => {
    const existing = await signUp("ana@rollo.test");
    await closeRegistrations();
    await env.DB.prepare("UPDATE auth_codes SET created_at = created_at - 7200000 WHERE email = ?").bind(existing.email).run();
    const known = await api("POST", "/auth/email/start", { body: { email: existing.email } });
    devSentCodes.delete("nueva@rollo.test");
    const unknown = await api("POST", "/auth/email/start", { body: { email: "nueva@rollo.test" } });
    expect(unknown.status).toBe(known.status);
    expect(unknown.status).toBe(204);
    expect(unknown.body).toEqual(known.body);
    expect(devSentCodes.get("nueva@rollo.test")).toBeTruthy();
    const row = await env.DB.prepare("SELECT count FROM email_counters WHERE kind = 'login_new'").first<{ count: number }>();
    expect(row!.count).toBe(2); // ana's signUp + nueva
  });

  it("the App Review account can still get in", async () => {
    await closeRegistrations();
    const reviewEnv = { REVIEW_EMAIL: "review@rollo.test", REVIEW_CODE: "ABC234" };
    expect((await api("POST", "/auth/email/start", { body: { email: "review@rollo.test" }, env: reviewEnv })).status).toBe(204);
    const res = await api("POST", "/auth/email/verify", { body: { email: "review@rollo.test", code: "ABC234" }, env: reviewEnv });
    expect(res.status).toBe(200);
  });

  it("open (the default): a new email signs up as always", async () => {
    const code = await requestCode("nueva@rollo.test");
    expect((await api("POST", "/auth/email/verify", { body: { email: "nueva@rollo.test", code } })).status).toBe(200);
  });
});

describe("GET /config", () => {
  it("is public and open by default", async () => {
    const res = await api("GET", "/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registrationsOpen: true });
  });

  it("reflects the switch right away on this isolate", async () => {
    const su = await makeSuperadmin();
    expect((await api("GET", "/config")).body.registrationsOpen).toBe(true);
    expect((await api("PUT", "/admin/registrations", { token: su.token, body: { open: false } })).status).toBe(200);
    expect((await api("GET", "/config")).body).toEqual({ registrationsOpen: false });
    await api("PUT", "/admin/registrations", { token: su.token, body: { open: true } });
    expect((await api("GET", "/config")).body).toEqual({ registrationsOpen: true });
  });

  it("caches the flag for 60 s and refreshes after", async () => {
    expect(await areRegistrationsOpen(env, 1_000_000)).toBe(true);
    await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('registrations_closed', '1', 0)").run();
    expect(await areRegistrationsOpen(env, 1_000_000 + 59_000)).toBe(true);
    expect(await areRegistrationsOpen(env, 1_000_000 + 60_000)).toBe(false);
  });
});

describe("/admin/registrations", () => {
  it("GET is open by default; the superadmin closes and opens it", async () => {
    const su = await makeSuperadmin();
    expect((await api("GET", "/admin/registrations", { token: su.token })).body).toEqual({ open: true, updatedAt: null, updatedBy: null });
    const closed = await api("PUT", "/admin/registrations", { token: su.token, body: { open: false } });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ open: false, updatedBy: { id: su.userId, email: su.email } });
    expect(typeof closed.body.updatedAt).toBe("number");
    expect((await api("GET", "/admin/registrations", { token: su.token })).body.open).toBe(false);
    expect((await api("PUT", "/admin/registrations", { token: su.token, body: { open: true } })).body.open).toBe(true);
  });

  it("a plain user and anonymous get 404 on both", async () => {
    const { token } = await signUp();
    for (const t of [token, undefined]) {
      expect((await api("GET", "/admin/registrations", { token: t })).status).toBe(404);
      expect((await api("PUT", "/admin/registrations", { token: t, body: { open: false } })).status).toBe(404);
    }
  });

  it("ADMIN_TOKEN can read but not change it (PUT is session only)", async () => {
    const adminEnv = { ADMIN_TOKEN: "secret-admin" };
    expect((await api("GET", "/admin/registrations", { token: "secret-admin", env: adminEnv })).status).toBe(200);
    expect((await api("PUT", "/admin/registrations", { token: "secret-admin", env: adminEnv, body: { open: false } })).status).toBe(404);
  });

  it("rejects an invalid body", async () => {
    const su = await makeSuperadmin();
    expect((await api("PUT", "/admin/registrations", { token: su.token, body: { open: "no" } })).status).toBe(400);
    expect((await api("PUT", "/admin/registrations", { token: su.token, body: {} })).status).toBe(400);
  });
});
