import { describe, expect, it } from "vitest";
import { RATE_LIMIT_MESSAGE } from "../src/lib/rate-limit";
import { api, befriend, signUp } from "./helpers";

/** In-memory stand-in for a Workers Rate Limiting binding (same as test/rate-limit.test.ts). */
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

/** A unique 5-letter tag so data from one test never matches another test's query (tests share one D1). */
const tag = () => Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

const search = (token: string, q: string, env?: Record<string, unknown>) =>
  api("GET", `/users/search?q=${encodeURIComponent(q)}`, { token, env });
const ids = (res: { body: any }) => (res.body.users as any[]).map((u) => u.id);

describe("GET /users/search", () => {
  it("matches by username prefix and by the start of any word of the name", async () => {
    const t = tag();
    const me = await signUp(undefined, "Viewer", `v${t}`);
    const first = await signUp(undefined, `${t}cami Sosa`, `zz${t}cs`);
    const second = await signUp(undefined, `Ana ${t}camila`, `zz${t}ac`);
    const third = await signUp(undefined, `${t}micaela`, `zz${t}mi`);
    const res = await search(me.token, `${t}cami`);
    expect(res.status).toBe(200);
    expect(new Set(ids(res))).toEqual(new Set([first.userId, second.userId]));
    expect(ids(res)).not.toContain(third.userId);
    // By username prefix too.
    expect(ids(await search(me.token, `zz${t}m`))).toEqual([third.userId]);
  });

  it("matches ignoring accents and case", async () => {
    const t = tag();
    const me = await signUp(undefined, "Viewer", `v${t}`);
    const target = await signUp(undefined, `${t}Martín`, `zz${t}mt`);
    expect(ids(await search(me.token, `${t}MARTIN`))).toEqual([target.userId]);
    expect(ids(await search(me.token, `@ZZ${t}M`))).toEqual([target.userId]);
    expect(ids(await search(me.token, `${t}martín`))).toEqual([target.userId]);
  });

  it("escapes LIKE wildcards", async () => {
    const t = tag();
    const me = await signUp(undefined, "Viewer", `v${t}`);
    const literal = await signUp(undefined, `${t} 50%x`, `zz${t}pc`);
    await signUp(undefined, `${t} 50ab`, `zz${t}pd`);
    await signUp(undefined, `${t}ab`, `zz${t}ua`);
    expect(ids(await search(me.token, `50%`))).toEqual([literal.userId]);
    expect(ids(await search(me.token, `${t}a_`))).toEqual([]);
    expect(ids(await search(me.token, "%%"))).toEqual([]);
    expect(ids(await search(me.token, "a\\"))).toEqual([]);
  });

  it("excludes yourself, your friends, blocks either way and incomplete accounts", async () => {
    const t = tag();
    const me = await signUp(undefined, `${t}me`, `zz${t}me`);
    const friend = await signUp(undefined, `${t}friend`, `zz${t}fr`);
    const blockedByMe = await signUp(undefined, `${t}blockedbyme`, `zz${t}bm`);
    const blocksMe = await signUp(undefined, `${t}blocksme`, `zz${t}bk`);
    await signUp(undefined, null, `zz${t}nn`);
    await signUp(undefined, `${t}nouser`, null);
    const visible = await signUp(undefined, `${t}visible`, `zz${t}vi`);
    await befriend(me.token, friend.token);
    expect((await api("PUT", `/blocks/${blockedByMe.userId}`, { token: me.token })).status).toBeLessThan(300);
    expect((await api("PUT", `/blocks/${me.userId}`, { token: blocksMe.token })).status).toBeLessThan(300);
    const res = await search(me.token, t);
    expect(ids(res)).toEqual([visible.userId]);
    expect(ids(await search(me.token, `@zz${t}`))).toEqual([visible.userId]);
  });

  it("orders exact username, then mutual friends, then name", async () => {
    const t = tag();
    const me = await signUp(undefined, "Viewer", `v${t}`);
    const m1 = await signUp(undefined, "Mutual one", `zz${t}m1`);
    const m2 = await signUp(undefined, "Mutual two", `zz${t}m2`);
    await befriend(me.token, m1.token);
    await befriend(me.token, m2.token);
    const exact = await signUp(undefined, `Zeta ${t}`, `zz${t}`); // @zz<t>: exact handle
    const two = await signUp(undefined, `${t} Zulu`, `zz${t}2m`);
    const one = await signUp(undefined, `${t} Yankee`, `zz${t}1m`);
    const zeroB = await signUp(undefined, `${t} Bravo`, `zz${t}0b`);
    const zeroA = await signUp(undefined, `${t} alfa`, `zz${t}0a`);
    await befriend(two.token, m1.token);
    await befriend(two.token, m2.token);
    await befriend(one.token, m1.token);
    const res = await search(me.token, `zz${t}`);
    // "zz<t>" is only a handle prefix for the others and the exact handle for `exact`.
    expect(ids(res)).toEqual([exact.userId, two.userId, one.userId, zeroA.userId, zeroB.userId]);
    expect((res.body.users as any[]).map((u) => u.mutualCount)).toEqual([0, 2, 1, 0, 0]);
  });

  it("returns at most 20", async () => {
    const t = tag();
    const me = await signUp(undefined, "Viewer", `v${t}`);
    for (let i = 0; i < 22; i++) await signUp(undefined, `${t} person ${String(i).padStart(2, "0")}`, `zz${t}${String(i).padStart(2, "0")}`);
    expect((await search(me.token, t)).body.users).toHaveLength(20);
  });

  it("reports mutualCount and friendRequest", async () => {
    const t = tag();
    const me = await signUp(undefined, "Viewer", `v${t}`);
    const none = await signUp(undefined, `${t} none`, `zz${t}no`);
    const sent = await signUp(undefined, `${t} sent`, `zz${t}se`);
    const received = await signUp(undefined, `${t} received`, `zz${t}re`);
    const mutual = await signUp(undefined, `${t} mutual`, `zz${t}mu`);
    await befriend(me.token, mutual.token);
    await befriend(sent.token, mutual.token);
    expect((await api("POST", `/users/${sent.userId}/friend-request`, { token: me.token })).status).toBe(200);
    expect((await api("POST", `/users/${me.userId}/friend-request`, { token: received.token })).status).toBe(200);
    const res = await search(me.token, t);
    const byId = Object.fromEntries((res.body.users as any[]).map((u) => [u.id, u]));
    expect(byId[none.userId]).toEqual({ id: none.userId, name: `${t} none`, username: `zz${t}no`, avatarUrl: null, mutualCount: 0, friendRequest: "none" });
    expect(byId[sent.userId]).toMatchObject({ mutualCount: 1, friendRequest: "sent" });
    expect(byId[received.userId]).toMatchObject({ mutualCount: 0, friendRequest: "received" });
    expect(Object.keys(byId[none.userId]).sort()).toEqual(["avatarUrl", "friendRequest", "id", "mutualCount", "name", "username"]);
  });

  it("rejects q shorter than 2 or longer than 30 after normalizing, and requires a session", async () => {
    const me = await signUp();
    expect((await search(me.token, "@a")).status).toBe(400);
    expect((await search(me.token, " a ")).status).toBe(400);
    expect((await search(me.token, "")).status).toBe(400);
    expect((await search(me.token, "a".repeat(31))).status).toBe(400);
    expect((await search(me.token, "a".repeat(30))).status).toBe(200);
    expect((await api("GET", "/users/search")).status).toBe(401);
    expect((await api("GET", "/users/search?q=ab")).status).toBe(401);
  });

  it("has its own rate limit", async () => {
    const me = await signUp();
    const blocked = await search(me.token, "ab", { RL_SEARCH: fakeLimiter(0) });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: RATE_LIMIT_MESSAGE });
    expect((await search(me.token, "ab", { RL_EXPENSIVE: fakeLimiter(0) })).status).toBe(200);
  });
});
