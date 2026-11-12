import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { devSentWaitlist } from "../src/lib/email";
import { WAITLIST_EMAILS_PER_DAY, WAITLIST_POSTS_PER_IP_PER_DAY } from "../src/lib/email-caps";
import { api, DAY, HOUR } from "./helpers";
import type { ApiResponse } from "./helpers";

beforeEach(() => {
  devSentWaitlist.length = 0;
});

const join = (email: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  api("POST", "/waitlist", { body: { email, consent: true, ...extra }, headers });
const row = (email: string) => env.DB.prepare("SELECT * FROM waitlist WHERE email = ?").bind(email).first<Record<string, any>>();
const today = () => new Date().toISOString().slice(0, 10);
/** Path + query of a link sent in the email, to call it on the test origin. */
const path = (url: string) => url.replace("https://rollo.test", "");
/** POST like the page button does: form-encoded, token in the body. */
async function postForm(url: string, action: "confirm" | "unsubscribe", token = new URL(url).searchParams.get("token")!): Promise<ApiResponse<string>> {
  const res = await exports.default.fetch(
    new Request(`https://rollo.test/waitlist/${action}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    }),
  );
  return { status: res.status, body: await res.text(), headers: res.headers };
}
const confirm = (url: string) => postForm(url, "confirm");
const unsub = (url: string) => postForm(url, "unsubscribe");
const lastSent = () => devSentWaitlist.at(-1)!;

describe("POST /waitlist", () => {
  it("answers 204, stores the email normalized and sends one email with a confirm and an unsubscribe link", async () => {
    const res = await join("  Ana@Rollo.TEST ");
    expect(res.status).toBe(204);
    expect(res.body).toBe("");
    expect(devSentWaitlist).toHaveLength(1);
    expect(lastSent().email).toBe("ana@rollo.test");
    expect(lastSent().confirmUrl).toMatch(/^https:\/\/rollo\.test\/waitlist\/confirm\?token=[A-Za-z0-9_-]{43}$/);
    expect(lastSent().unsubscribeUrl).toMatch(/^https:\/\/rollo\.test\/waitlist\/unsubscribe\?token=[A-Za-z0-9_-]{43}$/);
    const r = await row("ana@rollo.test");
    expect(r).toMatchObject({ source: "app", confirmed_at: null, unsubscribed_at: null });
    expect(typeof r!.last_sent_at).toBe("number");
  });

  it("stores only hashes of the tokens", async () => {
    await join("ana@rollo.test");
    const dump = JSON.stringify(await row("ana@rollo.test"));
    for (const url of [lastSent().confirmUrl, lastSent().unsubscribeUrl]) {
      expect(dump).not.toContain(new URL(url).searchParams.get("token")!);
    }
  });

  it("keeps the source (app by default, web when sent) and rejects any other", async () => {
    await join("a@rollo.test");
    await join("b@rollo.test", { source: "web" });
    expect((await row("a@rollo.test"))!.source).toBe("app");
    expect((await row("b@rollo.test"))!.source).toBe("web");
    expect((await join("c@rollo.test", { source: "otro" })).status).toBe(400);
  });

  it("requires consent: true and a valid email", async () => {
    expect((await api("POST", "/waitlist", { body: { email: "a@rollo.test" } })).status).toBe(400);
    expect((await api("POST", "/waitlist", { body: { email: "a@rollo.test", consent: false } })).status).toBe(400);
    const noMail = await join("no-es-un-mail");
    expect(noMail.status).toBe(400);
    expect(noMail.body.error).toContain("email válido");
    expect(await row("a@rollo.test")).toBeNull();
    expect(devSentWaitlist).toHaveLength(0);
  });

  it("a second post within 24 h answers the same and does not send again; after 24 h it sends a fresh link", async () => {
    await join("ana@rollo.test");
    const first = lastSent();
    const again = await join("ana@rollo.test");
    expect(again.status).toBe(204);
    expect(again.body).toBe("");
    expect(devSentWaitlist).toHaveLength(1);

    await env.DB.prepare("UPDATE waitlist SET last_sent_at = last_sent_at - ?").bind(25 * HOUR).run();
    expect((await join("ana@rollo.test")).status).toBe(204);
    expect(devSentWaitlist).toHaveLength(2);
    expect(lastSent().confirmUrl).not.toBe(first.confirmUrl);
    // The old link no longer matches the stored hash.
    expect((await confirm(first.confirmUrl)).status).toBe(400);
    expect((await confirm(lastSent().confirmUrl)).status).toBe(200);
  });

  it("already confirmed and not unsubscribed: 204 and no email, even after 24 h", async () => {
    await join("ana@rollo.test");
    await confirm(lastSent().confirmUrl);
    await env.DB.prepare("UPDATE waitlist SET last_sent_at = last_sent_at - ?").bind(3 * DAY).run();
    devSentWaitlist.length = 0;
    expect((await join("ana@rollo.test")).status).toBe(204);
    expect(devSentWaitlist).toHaveLength(0);
  });

  it("over the daily email cap it answers 204, sends nothing and stores nothing", async () => {
    await env.DB.prepare("INSERT INTO email_counters (kind, day, count) VALUES ('waitlist', ?, ?)").bind(today(), WAITLIST_EMAILS_PER_DAY).run();
    const res = await join("ana@rollo.test");
    expect(res.status).toBe(204);
    expect(devSentWaitlist).toHaveLength(0);
    expect(await row("ana@rollo.test")).toBeNull();
  });

  it("each email sent takes one slot of the daily cap", async () => {
    await join("a@rollo.test");
    await join("b@rollo.test");
    await join("a@rollo.test"); // not sent: no slot
    const c = await env.DB.prepare("SELECT count FROM email_counters WHERE kind = 'waitlist'").first<{ count: number }>();
    expect(c!.count).toBe(2);
  });

  it("caps the posts per IP per day (204, nothing sent) without touching other IPs", async () => {
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < WAITLIST_POSTS_PER_IP_PER_DAY; i++) expect((await join(`p${i}@rollo.test`, {}, ip)).status).toBe(204);
    expect(devSentWaitlist).toHaveLength(WAITLIST_POSTS_PER_IP_PER_DAY);
    expect((await join("extra@rollo.test", {}, ip)).status).toBe(204);
    expect(devSentWaitlist).toHaveLength(WAITLIST_POSTS_PER_IP_PER_DAY);
    expect(await row("extra@rollo.test")).toBeNull();
    expect((await join("otro@rollo.test", {}, { "cf-connecting-ip": "203.0.113.10" })).status).toBe(204);
    expect(devSentWaitlist).toHaveLength(WAITLIST_POSTS_PER_IP_PER_DAY + 1);
  });

  it("works while registrations are closed (that is what the list is for)", async () => {
    await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('registrations_closed', '1', 0)").run();
    expect((await join("ana@rollo.test")).status).toBe(204);
    expect(devSentWaitlist).toHaveLength(1);
  });

  it("emails through Resend with links on the request origin and a List-Unsubscribe header; a failed send is not counted nor stored", async () => {
    const realFetch = globalThis.fetch;
    const calls: any[] = [];
    let status = 500;
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status });
    }) as typeof fetch;
    try {
      const failed = await api("POST", "/waitlist", { body: { email: "ana@rollo.test", consent: true }, env: { RESEND_API_KEY: "re_test" } });
      expect(failed.status).toBe(502);
      expect(await row("ana@rollo.test")).toBeNull();
      expect(await env.DB.prepare("SELECT count FROM email_counters WHERE kind = 'waitlist'").first<{ count: number }>()).toEqual({ count: 0 });

      status = 200;
      const ok = await api("POST", "/waitlist", { body: { email: "ana@rollo.test", consent: true }, env: { RESEND_API_KEY: "re_test" } });
      expect(ok.status).toBe(204);
    } finally {
      globalThis.fetch = realFetch;
    }
    const sent = calls.at(-1);
    expect(sent.to).toEqual(["ana@rollo.test"]);
    expect(sent.text).toMatch(/https:\/\/rollo\.test\/waitlist\/confirm\?token=/);
    expect(sent.text).toMatch(/https:\/\/rollo\.test\/waitlist\/unsubscribe\?token=/);
    expect(sent.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/rollo\.test\/waitlist\/unsubscribe\?token=/);
    expect(sent.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent.reply_to).toBeTruthy();
  });
});

describe("/waitlist/confirm", () => {
  it("confirms with a Spanish HTML page; opening it again is idempotent", async () => {
    await join("ana@rollo.test");
    const res = await confirm(lastSent().confirmUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.body).toContain("¡Listo! Te vamos a avisar cuando Rollo abra para todos.");
    const confirmedAt = (await row("ana@rollo.test"))!.confirmed_at;
    expect(typeof confirmedAt).toBe("number");
    const again = await confirm(lastSent().confirmUrl);
    expect(again.status).toBe(200);
    expect(again.body).toContain("¡Listo!");
    expect((await row("ana@rollo.test"))!.confirmed_at).toBe(confirmedAt);
  });

  it("an invalid, unknown or missing token is a 400 page", async () => {
    await join("ana@rollo.test");
    for (const url of ["/waitlist/confirm?token=abc", `/waitlist/confirm?token=${"A".repeat(43)}`, "/waitlist/confirm"]) {
      const res = await api("GET", url);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.body).toContain("El link no es válido.");
    }
    // The unsubscribe token is not a confirm token.
    const unsub = new URL(lastSent().unsubscribeUrl).searchParams.get("token");
    expect((await api("GET", `/waitlist/confirm?token=${unsub}`)).status).toBe(400);
    expect((await row("ana@rollo.test"))!.confirmed_at).toBeNull();
  });

  it("does not confirm someone who already unsubscribed", async () => {
    await join("ana@rollo.test");
    await unsub(lastSent().unsubscribeUrl);
    expect((await confirm(lastSent().confirmUrl)).status).toBe(400);
    expect((await row("ana@rollo.test"))!.confirmed_at).toBeNull();
  });
});

describe("/waitlist/unsubscribe", () => {
  it("unsubscribes with a Spanish page, idempotently", async () => {
    await join("ana@rollo.test");
    await confirm(lastSent().confirmUrl);
    const res = await unsub(lastSent().unsubscribeUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.body).toContain("Te diste de baja de la lista.");
    const at = (await row("ana@rollo.test"))!.unsubscribed_at;
    expect(typeof at).toBe("number");
    expect((await unsub(lastSent().unsubscribeUrl)).status).toBe(200);
    expect((await row("ana@rollo.test"))!.unsubscribed_at).toBe(at);
  });

  it("a bad token is a 400 page", async () => {
    for (const url of ["/waitlist/unsubscribe?token=abc", `/waitlist/unsubscribe?token=${"B".repeat(43)}`, "/waitlist/unsubscribe"]) {
      const res = await api("GET", url);
      expect(res.status).toBe(400);
      expect(res.body).toContain("El link no es válido.");
    }
  });

  it("posting again re-subscribes: a new confirmation is sent right away and confirming clears the unsubscribe", async () => {
    await join("ana@rollo.test");
    await confirm(lastSent().confirmUrl);
    await unsub(lastSent().unsubscribeUrl);
    expect((await join("ana@rollo.test")).status).toBe(204);
    expect(devSentWaitlist).toHaveLength(2);
    expect(await row("ana@rollo.test")).toMatchObject({ confirmed_at: null, unsubscribed_at: null });
    expect((await confirm(lastSent().confirmUrl)).status).toBe(200);
    expect(await row("ana@rollo.test")).toMatchObject({ unsubscribed_at: null });
    expect(typeof (await row("ana@rollo.test"))!.confirmed_at).toBe("number");
  });
});

describe("mail scanners: GET never changes anything", () => {
  it("GET confirm and unsubscribe show a page with a POST button and leave the row untouched", async () => {
    await join("ana@rollo.test");
    const before = await row("ana@rollo.test");
    const c = await api("GET", path(lastSent().confirmUrl));
    expect(c.status).toBe(200);
    expect(c.headers.get("content-type")).toContain("text/html");
    expect(c.headers.get("cache-control")).toContain("no-store");
    expect(c.headers.get("referrer-policy")).toBe("no-referrer");
    expect(c.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(c.body).toContain('method="post"');
    expect(c.body).toContain('action="/waitlist/confirm"');
    expect(c.body).toContain("Confirmar");
    expect(c.body).not.toContain("¡Listo!");
    const u = await api("GET", path(lastSent().unsubscribeUrl));
    expect(u.status).toBe(200);
    expect(u.body).toContain('action="/waitlist/unsubscribe"');
    expect(u.body).toContain("Darme de baja");
    expect(await row("ana@rollo.test")).toEqual(before);
  });

  it("POST with a bad or missing token is the 400 page and changes nothing", async () => {
    await join("ana@rollo.test");
    for (const action of ["confirm", "unsubscribe"] as const) {
      const bad = await postForm(lastSent().confirmUrl, action, "x".repeat(43));
      expect(bad.status).toBe(400);
      expect(bad.body).toContain("El link no es válido.");
      expect((await postForm(lastSent().confirmUrl, action, "")).status).toBe(400);
    }
    expect(await row("ana@rollo.test")).toMatchObject({ confirmed_at: null, unsubscribed_at: null });
  });

  it("RFC 8058 one-click: POST to the unsubscribe URL (token in the query) with List-Unsubscribe=One-Click unsubscribes", async () => {
    await join("ana@rollo.test");
    const res = await exports.default.fetch(
      new Request(lastSent().unsubscribeUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
    );
    expect(res.status).toBe(200);
    expect(typeof (await row("ana@rollo.test"))!.unsubscribed_at).toBe("number");
  });
});

describe("combined daily budget (login codes win)", () => {
  const set = (kind: string, count: number) =>
    env.DB.prepare("INSERT INTO email_counters (kind, day, count) VALUES (?, ?, ?)").bind(kind, today(), count).run();

  it("with login + support + waitlist at 70 or more it answers 204 and sends and stores nothing", async () => {
    await set("login", 60);
    await set("support", 5);
    await set("waitlist", 5);
    const res = await join("ana@rollo.test");
    expect(res.status).toBe(204);
    expect(devSentWaitlist).toHaveLength(0);
    expect(await row("ana@rollo.test")).toBeNull();
  });

  it("at 69 it still sends one more, and the slot it takes counts", async () => {
    await set("login", 69);
    expect((await join("a@rollo.test")).status).toBe(204);
    expect(devSentWaitlist).toHaveLength(1);
    await join("b@rollo.test");
    expect(devSentWaitlist).toHaveLength(1);
  });

  it("per-IP and login_new counters are not double counted", async () => {
    await set("login", 40);
    await set("login_new", 40);
    await set("login_new_ip:1.2.3.4", 20);
    expect((await join("a@rollo.test")).status).toBe(204);
    expect(devSentWaitlist).toHaveLength(1);
  });
});
