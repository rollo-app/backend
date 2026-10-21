import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, DAY, signUp } from "./helpers";

const link = async (token: string) => (await api("POST", "/friends/link", { token })).body as { code: string; expiresAt: number };
const friendsOf = async (token: string) => (await api("GET", "/friends", { token })).body.friends as any[];
const ageLinks = (ms: number) => env.DB.prepare("UPDATE friend_links SET expires_at = expires_at - ?").bind(ms).run();
const ageClaims = (ms: number) => env.DB.prepare("UPDATE friend_claims SET expires_at = expires_at - ?").bind(ms).run();

describe("friend links", () => {
  it("link -> claim (no session) -> redeem creates a symmetric friendship", async () => {
    const a = await signUp(undefined, "Ana", "ana1");
    const b = await signUp(undefined, "Beto", "beto1");
    const { code, expiresAt } = await link(a.token);
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    expect(expiresAt).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60_000);

    const claim = await api("POST", "/friend-links/claim", { body: { code } });
    expect(claim.status).toBe(200);
    expect(claim.body.creator).toEqual({ name: "Ana", username: "ana1", avatarUrl: null });
    expect(claim.body.expiresAt).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);

    const redeem = await api("POST", "/friends/redeem", { token: b.token, body: { claimToken: claim.body.claimToken } });
    expect(redeem.status).toBe(200);
    expect(redeem.body.friend).toEqual({ id: a.userId, name: "Ana", username: "ana1", avatarUrl: null });

    expect((await friendsOf(a.token)).map((f) => f.id)).toEqual([b.userId]);
    expect((await friendsOf(b.token)).map((f) => f.id)).toEqual([a.userId]);
  });

  it("redeems directly with the code of a live link", async () => {
    const a = await signUp();
    const b = await signUp();
    const { code } = await link(a.token);
    const res = await api("POST", "/friends/redeem", { token: b.token, body: { code } });
    expect(res.status).toBe(200);
    expect(res.body.friend.id).toBe(a.userId);
  });

  it("normalizes lowercase, spaces and dashes", async () => {
    const a = await signUp();
    const b = await signUp();
    const { code } = await link(a.token);
    const typed = ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()} `;
    expect((await api("POST", "/friend-links/claim", { body: { code: typed } })).status).toBe(200);
    expect((await api("POST", "/friends/redeem", { token: b.token, body: { code: typed } })).status).toBe(200);
  });

  it("answers the same generic 400 for expired, replaced, unknown and malformed codes", async () => {
    const a = await signUp();
    const b = await signUp();
    const old = await link(a.token);
    await link(a.token); // replaces `old`
    const expired = await link(a.token);
    await ageLinks(2 * 60 * 60_000);

    const bodies = new Set<string>();
    for (const code of [old.code, expired.code, "ZZZZZZZZ", "abc"]) {
      const c1 = await api("POST", "/friend-links/claim", { body: { code } });
      const c2 = await api("POST", "/friends/redeem", { token: b.token, body: { code } });
      expect(c1.status).toBe(400);
      expect(c2.status).toBe(400);
      bodies.add(JSON.stringify(c1.body));
      bodies.add(JSON.stringify(c2.body));
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: "Código incorrecto o vencido" })]);
  });

  it("a new link invalidates the previous one", async () => {
    const a = await signUp();
    const b = await signUp();
    const first = await link(a.token);
    const second = await link(a.token);
    expect((await api("POST", "/friends/redeem", { token: b.token, body: { code: first.code } })).status).toBe(400);
    expect((await api("POST", "/friends/redeem", { token: b.token, body: { code: second.code } })).status).toBe(200);
  });

  it("is multi-use while the link lives", async () => {
    const a = await signUp();
    const { code } = await link(a.token);
    for (let i = 0; i < 3; i++) {
      const u = await signUp();
      expect((await api("POST", "/friends/redeem", { token: u.token, body: { code } })).status).toBe(200);
    }
    expect(await friendsOf(a.token)).toHaveLength(3);
  });

  it("a claim token works for 24 hours even after the link expired, and not after", async () => {
    const a = await signUp();
    const b = await signUp();
    const { code } = await link(a.token);
    const { claimToken } = (await api("POST", "/friend-links/claim", { body: { code } })).body;

    await ageLinks(2 * 60 * 60_000); // link is gone, token still fine
    expect((await api("POST", "/friends/redeem", { token: b.token, body: { claimToken } })).status).toBe(200);

    await api("DELETE", `/friends/${a.userId}`, { token: b.token });
    await ageClaims(25 * 60 * 60_000);
    const late = await api("POST", "/friends/redeem", { token: b.token, body: { claimToken } });
    expect(late.status).toBe(400);
    expect(late.body.error).toBe("Código incorrecto o vencido");
  });

  it("redeeming your own link or twice is not an error and does not duplicate", async () => {
    const a = await signUp();
    const b = await signUp();
    const { code } = await link(a.token);
    const own = await api("POST", "/friends/redeem", { token: a.token, body: { code } });
    expect(own.status).toBe(200);
    expect(await friendsOf(a.token)).toEqual([]);

    expect((await api("POST", "/friends/redeem", { token: b.token, body: { code } })).status).toBe(200);
    expect((await api("POST", "/friends/redeem", { token: b.token, body: { code } })).status).toBe(200);
    expect(await friendsOf(b.token)).toHaveLength(1);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM friendships").first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it("requires exactly one of code or claimToken", async () => {
    const b = await signUp();
    expect((await api("POST", "/friends/redeem", { token: b.token, body: {} })).status).toBe(400);
    expect((await api("POST", "/friends/redeem", { token: b.token, body: { code: "AAAAAAAA", claimToken: "x" } })).status).toBe(400);
  });

  it("locks a user after 10 failed attempts (429), even with a good code", async () => {
    const a = await signUp();
    const b = await signUp();
    const { code } = await link(a.token);
    for (let i = 0; i < 10; i++) {
      expect((await api("POST", "/friends/redeem", { token: b.token, body: { code: "ZZZZZZZZ" } })).status).toBe(400);
    }
    const locked = await api("POST", "/friends/redeem", { token: b.token, body: { code } });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe("Demasiados intentos, probá más tarde");
  });

  it("locks an IP after 10 failed attempts, on claim and redeem", async () => {
    const a = await signUp();
    const { code } = await link(a.token);
    const headers = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < 10; i++) {
      expect((await api("POST", "/friend-links/claim", { body: { code: "ZZZZZZZZ" }, headers })).status).toBe(400);
    }
    expect((await api("POST", "/friend-links/claim", { body: { code }, headers })).status).toBe(429);
    const b = await signUp();
    expect((await api("POST", "/friends/redeem", { token: b.token, body: { code }, headers })).status).toBe(429);
    // another IP is unaffected
    expect((await api("POST", "/friend-links/claim", { body: { code }, headers: { "cf-connecting-ip": "203.0.113.10" } })).status).toBe(200);
  });

  it("failed attempts older than an hour stop counting", async () => {
    const b = await signUp();
    for (let i = 0; i < 10; i++) await api("POST", "/friends/redeem", { token: b.token, body: { code: "ZZZZZZZZ" } });
    await env.DB.prepare("UPDATE friend_attempts SET created_at = created_at - ?").bind(61 * 60_000).run();
    expect((await api("POST", "/friends/redeem", { token: b.token, body: { code: "ZZZZZZZZ" } })).status).toBe(400);
  });

  it("DELETE /friends/{id} removes the friendship both ways, also if they were not friends", async () => {
    const a = await signUp();
    const b = await signUp();
    const { code } = await link(a.token);
    await api("POST", "/friends/redeem", { token: b.token, body: { code } });
    expect((await api("DELETE", `/friends/${b.userId}`, { token: a.token })).status).toBe(204);
    expect(await friendsOf(a.token)).toEqual([]);
    expect(await friendsOf(b.token)).toEqual([]);
    expect((await api("DELETE", `/friends/${b.userId}`, { token: a.token })).status).toBe(204);
    expect((await api("DELETE", `/friends/nobody`, { token: a.token })).status).toBe(204);
  });

  it("lists friends ordered by name", async () => {
    const me = await signUp();
    const zoe = await signUp(undefined, "Zoe", "zoe1");
    const ana = await signUp(undefined, "ana", "ana2");
    const { code } = await link(me.token);
    for (const u of [zoe, ana]) await api("POST", "/friends/redeem", { token: u.token, body: { code } });
    expect((await friendsOf(me.token)).map((f) => f.name)).toEqual(["ana", "Zoe"]);
  });

  it("only claim is public", async () => {
    expect((await api("POST", "/friends/link")).status).toBe(401);
    expect((await api("POST", "/friends/redeem", { body: { code: "AAAAAAAA" } })).status).toBe(401);
    expect((await api("GET", "/friends")).status).toBe(401);
    expect((await api("DELETE", "/friends/x")).status).toBe(401);
    expect((await api("POST", "/friend-links/claim", { body: { code: "AAAAAAAA" } })).status).toBe(400);
  });

  it("stores only hashes of the code and the claim token", async () => {
    const a = await signUp();
    const { code } = await link(a.token);
    const { claimToken } = (await api("POST", "/friend-links/claim", { body: { code } })).body;
    const l = await env.DB.prepare("SELECT code_hash FROM friend_links").first<{ code_hash: string }>();
    const c = await env.DB.prepare("SELECT claim_hash FROM friend_claims").first<{ claim_hash: string }>();
    expect(l!.code_hash).not.toBe(code);
    expect(c!.claim_hash).not.toBe(claimToken);
    expect(DAY).toBeGreaterThan(0);
  });
});
