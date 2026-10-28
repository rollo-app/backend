import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BACKFILL_CREATOR_SQL } from "../src/lib/creator";
import { api, DAY, joinAs, newTrip } from "./helpers";

const backfill = (tripId: string | null) =>
  env.DB.batch(BACKFILL_CREATOR_SQL.map((sql) => env.DB.prepare(sql).bind(tripId)));
const creatorOf = (tripId: string) =>
  env.DB.prepare("SELECT created_by_user_id c FROM trips WHERE id = ?").bind(tripId).first<{ c: string | null }>();
const roleOf = (memberId: string) =>
  env.DB.prepare("SELECT role FROM members WHERE id = ?").bind(memberId).first<{ role: string }>();

describe("migration 0029 backfill", () => {
  it("migration backfills a missing creator with the oldest active admin", async () => {
    const trip = await newTrip();
    await joinAs(trip.code, "Ana");
    await env.DB.prepare("UPDATE trips SET created_by_user_id = NULL WHERE id = ?").bind(trip.tripId).run();
    await backfill(null);
    expect((await creatorOf(trip.tripId))!.c).toBe(trip.adminUserId);
  });

  it("without active admins the oldest active member becomes creator and admin", async () => {
    const trip = await newTrip();
    const ana = await joinAs(trip.code, "Ana");
    const beto = await joinAs(trip.code, "Beto");
    await env.DB.prepare("UPDATE trips SET created_by_user_id = NULL WHERE id = ?").bind(trip.tripId).run();
    // The admin left; Ana is the oldest active member.
    await env.DB.prepare("UPDATE members SET left_at = 1 WHERE id = ?").bind(trip.adminId).run();
    await backfill(trip.tripId);
    expect((await creatorOf(trip.tripId))!.c).toBe(ana.userId);
    expect((await roleOf(ana.memberId))!.role).toBe("admin");
    expect((await roleOf(beto.memberId))!.role).toBe("member");
  });

  it("scoped to one trip leaves other trips untouched", async () => {
    const a = await newTrip();
    const b = await newTrip();
    await env.DB.prepare("UPDATE trips SET created_by_user_id = NULL WHERE id IN (?, ?)").bind(a.tripId, b.tripId).run();
    await backfill(a.tripId);
    expect((await creatorOf(a.tripId))!.c).toBe(a.adminUserId);
    expect((await creatorOf(b.tripId))!.c).toBeNull();
  });
});

// ---------- Task 2: creator and several admins ----------

/** Creator plus Ana, Beto (to be admins) and Caro (member), with explicit, ordered created_at. */
async function setup() {
  const trip = await newTrip();
  const ana = await joinAs(trip.code, "Ana");
  const beto = await joinAs(trip.code, "Beto");
  const caro = await joinAs(trip.code, "Caro");
  const order = [trip.adminId, ana.memberId, beto.memberId, caro.memberId];
  for (const [i, id] of order.entries()) await env.DB.prepare("UPDATE members SET created_at = ? WHERE id = ?").bind(1000 + i, id).run();
  const promote = (memberId: string) => api("POST", `/trips/${trip.tripId}/members/${memberId}/admin`, { token: trip.adminToken });
  return { trip, ana, beto, caro, promote };
}
const ADMIN_ONLY = "Solo quien creó el rollo puede hacer esto";

describe("admins and the creator", () => {
  it("an admin makes a member admin", async () => {
    const { trip, ana, beto, caro, promote } = await setup();
    const first = await promote(ana.memberId);
    expect(first.status).toBe(200);
    expect(first.body.role).toBe("admin");
    const second = await api("POST", `/trips/${trip.tripId}/members/${beto.memberId}/admin`, { token: ana.token });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ id: beto.memberId, role: "admin", isCreator: false });
    // Already admin: still 200.
    expect((await api("POST", `/trips/${trip.tripId}/members/${beto.memberId}/admin`, { token: ana.token })).status).toBe(200);
    // A plain member can't.
    expect((await api("POST", `/trips/${trip.tripId}/members/${beto.memberId}/admin`, { token: caro.token })).status).toBe(403);
    // Unknown target.
    expect((await api("POST", `/trips/${trip.tripId}/members/${crypto.randomUUID()}/admin`, { token: ana.token })).status).toBe(404);
  });

  it("only the creator removes an admin role", async () => {
    const { trip, ana, beto, promote } = await setup();
    await promote(ana.memberId);
    await promote(beto.memberId);
    const path = (id: string) => `/trips/${trip.tripId}/members/${id}/admin`;
    const denied = await api("DELETE", path(beto.memberId), { token: ana.token });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe(ADMIN_ONLY);
    const ok = await api("DELETE", path(beto.memberId), { token: trip.adminToken });
    expect(ok.status).toBe(200);
    expect(ok.body.role).toBe("member");
    const self = await api("DELETE", path(trip.adminId), { token: trip.adminToken });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("El creador siempre es admin");
  });

  it("admins remove members but not admins or the creator", async () => {
    const { trip, ana, beto, caro, promote } = await setup();
    await promote(ana.memberId);
    await promote(beto.memberId);
    const del = (id: string, token: string) => api("DELETE", `/trips/${trip.tripId}/members/${id}`, { token });
    expect((await del(caro.memberId, ana.token)).status).toBe(204);
    const adminTarget = await del(beto.memberId, ana.token);
    expect(adminTarget.status).toBe(403);
    expect(adminTarget.body.error).toBe(ADMIN_ONLY);
    const creatorTarget = await del(trip.adminId, ana.token);
    expect(creatorTarget.status).toBe(403);
    expect(creatorTarget.body.error).toBe("No podés sacar a quien creó el rollo");
    expect((await del(beto.memberId, trip.adminToken)).status).toBe(204);
  });

  it("an admin edits only the name", async () => {
    const { trip, ana, promote } = await setup();
    await promote(ana.memberId);
    const patch = (token: string, body: unknown) => api("PATCH", `/trips/${trip.tripId}`, { token, body });
    expect((await patch(ana.token, { name: "Nuevo" })).status).toBe(200);
    const denied = await patch(ana.token, { name: "X", revealAt: Date.now() + 40 * DAY });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe(ADMIN_ONLY);
    const after = await api("GET", `/trips/${trip.tripId}`, { token: trip.adminToken });
    expect(after.body.trip.name).toBe("Nuevo");
    expect((await patch(trip.adminToken, { revealAt: Date.now() + 40 * DAY })).status).toBe(200);
  });

  it("only the creator reveals early and toggles the private rollo", async () => {
    const { trip, ana, promote } = await setup();
    await promote(ana.memberId);
    expect((await api("POST", `/trips/${trip.tripId}/reveal`, { token: ana.token })).status).toBe(403);
    expect((await api("PATCH", `/trips/${trip.tripId}`, { token: ana.token, body: { featuringDisabled: true } })).status).toBe(403);
    expect((await api("POST", `/trips/${trip.tripId}/reveal`, { token: trip.adminToken })).status).toBe(200);
  });

  it("the creator can't leave; an admin who leaves comes back as a member", async () => {
    const { trip, ana, promote } = await setup();
    await promote(ana.memberId);
    const blocked = await api("DELETE", `/trips/${trip.tripId}/members/me`, { token: trip.adminToken });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("Creaste este rollo: no podés salirte");
    expect((await api("DELETE", `/trips/${trip.tripId}/members/me`, { token: ana.token })).status).toBe(204);
    const back = await api("POST", "/trips/join", { token: ana.token, body: { code: trip.code } });
    expect(back.status).toBe(201);
    expect(back.body.member.role).toBe("member");
  });

  it("detail and my trips say who created it", async () => {
    const { trip, ana, promote } = await setup();
    await promote(ana.memberId);
    const detail = await api("GET", `/trips/${trip.tripId}`, { token: ana.token });
    expect(detail.body.trip.createdBy).toEqual({ userId: trip.adminUserId, name: "Juani" });
    expect(detail.body.me.isCreator).toBe(false);
    expect(detail.body.members.filter((m: any) => m.isCreator).map((m: any) => m.userId)).toEqual([trip.adminUserId]);
    const mineAna = await api("GET", "/me/trips", { token: ana.token });
    expect(mineAna.body.trips[0].isCreator).toBe(false);
    const mineCreator = await api("GET", "/me/trips", { token: trip.adminToken });
    expect(mineCreator.body.trips[0].isCreator).toBe(true);
  });

  it("when the creator deletes the account the oldest admin becomes creator", async () => {
    const { trip, ana, beto, promote } = await setup();
    await promote(beto.memberId);
    await promote(ana.memberId);
    // Ana is older than Beto.
    const del = await api("DELETE", "/me", { token: trip.adminToken });
    expect(del.status).toBe(204);
    expect((await creatorOf(trip.tripId))!.c).toBe(ana.userId);
  });

  it("without admins the oldest active member becomes creator and admin", async () => {
    const { trip, ana, beto } = await setup();
    const del = await api("DELETE", "/me", { token: trip.adminToken });
    expect(del.status).toBe(204);
    expect((await creatorOf(trip.tripId))!.c).toBe(ana.userId);
    expect((await roleOf(ana.memberId))!.role).toBe("admin");
    expect((await roleOf(beto.memberId))!.role).toBe("member");
  });
});
