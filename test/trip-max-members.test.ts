import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import migrationSql from "../migrations/0036_trip_max_members.sql?raw";
import { flushPendingPushes } from "../src/lib/push";
import { addMembersDirect, api, befriend, joinAs, makeSuperadmin, mockExpo, newTrip, registerToken, signUp } from "./helpers";

const FULL_MESSAGE = "Este rollo está lleno (15 de 15). Pedile a quien lo creó que haga lugar.";
const joinCode = (code: string, token: string) => api("POST", "/trips/join", { token, body: { code } });
const addFriends = (tripId: string, token: string, friendIds: string[]) =>
  api("POST", `/trips/${tripId}/members`, { token, body: { friendIds } });

/** A trip with the admin plus `others` direct members (admin counts: 1 + others active). */
async function tripWith(others: number) {
  const t = await newTrip();
  const direct = await addMembersDirect(t.tripId, others);
  return { ...t, direct };
}

describe("join by code with a member cap", () => {
  it("the 16th person gets 409 with the numbers; the cap is 15 by default", async () => {
    const t = await tripWith(13);
    await joinAs(t.code, "Quince");
    const late = await signUp(undefined, "Dieciseis");
    const res = await joinCode(t.code, late.token);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: FULL_MESSAGE });
  });

  it("an active member re-joining a full rollo still gets 200", async () => {
    const t = await tripWith(14);
    const res = await joinCode(t.code, t.direct[0]!.token);
    expect(res.status).toBe(200);
  });

  it("someone who left cannot come back to a full rollo, but can when there is room", async () => {
    const t = await tripWith(13);
    const ana = await joinAs(t.code, "Ana");
    await api("DELETE", `/trips/${t.tripId}/members/me`, { token: ana.token });
    const filler = await joinAs(t.code, "Relleno");
    expect(filler.memberId).toBeTruthy();
    const blocked = await joinCode(t.code, ana.token);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toEqual({ error: FULL_MESSAGE });
    await api("DELETE", `/trips/${t.tripId}/members/${t.direct[0]!.memberId}`, { token: t.adminToken });
    const back = await joinCode(t.code, ana.token);
    expect(back.status).toBe(201);
    expect(back.body.member.id).toBe(ana.memberId);
  });

  it("two simultaneous joins on the last spot: exactly one gets in", async () => {
    const t = await tripWith(13);
    const [a, b] = await Promise.all([signUp(undefined, "Ana"), signUp(undefined, "Beto")]);
    const results = await Promise.all([joinCode(t.code, a.token), joinCode(t.code, b.token)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM members WHERE trip_id = ? AND left_at IS NULL AND removed_at IS NULL")
      .bind(t.tripId)
      .first<{ n: number }>();
    expect(n!.n).toBe(15);
  });
});

describe("adding friends with a member cap", () => {
  it("admin re-adding a removed member to a full rollo gets `full`", async () => {
    const t = await newTrip();
    const ana = await joinAs(t.code, "Ana");
    await befriend(t.adminToken, ana.token);
    await api("DELETE", `/trips/${t.tripId}/members/${ana.memberId}`, { token: t.adminToken });
    await addMembersDirect(t.tripId, 14);
    const res = await addFriends(t.tripId, t.adminToken, [ana.userId]);
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ userId: ana.userId, status: "full" }]);
  });

  it("3 spots left and 5 friends: the first 3 are added, the last 2 are full, push only to the 3", async () => {
    const expo = mockExpo();
    const t = await tripWith(11); // 12 active, 3 spots
    const friends = [];
    for (const name of ["F1", "F2", "F3", "F4", "F5"]) {
      const f = await signUp(undefined, name);
      await befriend(t.adminToken, f.token);
      friends.push({ ...f, push: await registerToken(f.token) });
    }
    await flushPendingPushes();
    expo.sent.length = 0;
    const res = await addFriends(t.tripId, t.adminToken, friends.map((f) => f.userId));
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(["added", "added", "added", "full", "full"]);
    await flushPendingPushes();
    expect(expo.sent.map((m) => m.to).sort()).toEqual(friends.slice(0, 3).map((f) => f.push).sort());
  });
});

describe("maxMembers in the contract", () => {
  it("appears in the create, join and detail responses (15 by default)", async () => {
    const t = await newTrip();
    const detail = await api("GET", `/trips/${t.tripId}`, { token: t.adminToken });
    expect(detail.body.trip.maxMembers).toBe(15);
    const joined = await joinCode(t.code, (await signUp()).token);
    expect(joined.body.trip.maxMembers).toBe(15);
  });
});

describe("migration 0036", () => {
  // The ALTER cannot run twice, so the test runs the migration's UPDATE (the logic that matters) on a rollo that was
  // created under the default cap and then got 20 active members, like a pre-migration rollo.
  const updateSql = migrationSql.slice(migrationSql.indexOf("UPDATE trips"));

  it("existing rollos above 15 active members get a cap equal to their active count; others keep 15", async () => {
    const big = await tripWith(19); // 20 active
    const small = await tripWith(4);
    const withLeft = await tripWith(16); // 17 active...
    await env.DB.prepare("UPDATE members SET left_at = 1 WHERE id IN (?, ?, ?)")
      .bind(withLeft.direct[0]!.memberId, withLeft.direct[1]!.memberId, withLeft.direct[2]!.memberId)
      .run(); // ...14 active after 3 left
    await env.DB.prepare("UPDATE trips SET max_members = 15").run();
    await env.DB.prepare(updateSql).run();
    const cap = async (id: string) =>
      (await env.DB.prepare("SELECT max_members m FROM trips WHERE id = ?").bind(id).first<{ m: number }>())!.m;
    expect(await cap(big.tripId)).toBe(20);
    expect(await cap(small.tripId)).toBe(15);
    expect(await cap(withLeft.tripId)).toBe(15);
  });
});

describe("PATCH /admin/trips/{tripId}", () => {
  const patch = (tripId: string, token: string, body: unknown) => api("PATCH", `/admin/trips/${tripId}`, { token, body });

  it("a superadmin raises the cap and a new join works", async () => {
    const su = await makeSuperadmin();
    const t = await tripWith(14);
    const late = await signUp(undefined, "Tarde");
    expect((await joinCode(t.code, late.token)).status).toBe(409);
    const res = await patch(t.tripId, su.token, { maxMembers: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: t.tripId, maxMembers: 30, activeMembers: 15 });
    expect((await joinCode(t.code, late.token)).status).toBe(201);
    expect((await api("GET", `/trips/${t.tripId}`, { token: t.adminToken })).body.trip.maxMembers).toBe(30);
  });

  it("below the active count, above 1000 or not an integer is a 400 in Spanish", async () => {
    const su = await makeSuperadmin();
    const t = await tripWith(9); // 10 active
    const low = await patch(t.tripId, su.token, { maxMembers: 9 });
    expect(low.status).toBe(400);
    expect(low.body.error).toContain("10");
    expect((await patch(t.tripId, su.token, { maxMembers: 10 })).status).toBe(200);
    expect((await patch(t.tripId, su.token, { maxMembers: 1001 })).status).toBe(400);
    expect((await patch(t.tripId, su.token, { maxMembers: 12.5 })).status).toBe(400);
    expect((await patch(t.tripId, su.token, {})).status).toBe(400);
  });

  it("an unknown rollo is 404, and a non-superadmin gets 404 like the other admin routes", async () => {
    const su = await makeSuperadmin();
    const t = await newTrip();
    expect((await patch(crypto.randomUUID(), su.token, { maxMembers: 20 })).status).toBe(404);
    expect((await patch(t.tripId, t.adminToken, { maxMembers: 20 })).status).toBe(404);
  });
});
