import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { DAY, HOUR, TZ, api, createTrip, grantEvents, makeSuperadmin, signUp } from "./helpers";

const NOT_ALLOWED = "Por ahora crear eventos está habilitado solo para algunas cuentas. Escribinos a support@rolloproject.com.";
const ONE_AT_A_TIME = "Ya tenés un evento sin revelar. Vas a poder crear otro cuando se revele.";

const eventBody = () => {
  const now = Date.now();
  return {
    name: "Casamiento",
    timezone: TZ,
    startsAt: now + HOUR,
    endsAt: now + 2 * HOUR,
    revealAt: now + 3 * HOUR,
    type: "event",
    groups: ["A", "B"],
    photoLimitMode: "total",
    totalPhotoLimit: 20,
  };
};
const createEvent = (token: string) => api("POST", "/trips", { token, body: eventBody() });
const tripCount = async (userId: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM trips WHERE created_by_user_id = ?").bind(userId).first<{ n: number }>())!.n;

describe("who can create events", () => {
  it("without the permission: 403 with the message and nothing is created", async () => {
    const u = await signUp();
    const res = await createEvent(u.token);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(NOT_ALLOWED);
    expect(await tripCount(u.userId)).toBe(0);
  });

  it("the permission check goes before the rollo limits", async () => {
    const u = await signUp();
    await createTrip(u.token);
    await createTrip(u.token);
    expect((await createEvent(u.token)).status).toBe(403);
  });

  it("with the permission: 201", async () => {
    const u = await signUp();
    await grantEvents(u.userId);
    const res = await createEvent(u.token);
    expect(res.status).toBe(201);
    expect(res.body.trip.type).toBe("event");
  });

  it("regular rollos do not need the permission", async () => {
    const u = await signUp();
    const trip = await createTrip(u.token);
    expect(trip.tripId).toEqual(expect.any(String));
  });

  it("a second event while the first is unrevealed: 409; after it is revealed: 201", async () => {
    const u = await signUp();
    await grantEvents(u.userId);
    const first = await createEvent(u.token);
    expect(first.status).toBe(201);
    const second = await createEvent(u.token);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe(ONE_AT_A_TIME);
    expect(await tripCount(u.userId)).toBe(1);
    await env.DB.prepare("UPDATE trips SET reveal_at = ? WHERE id = ?").bind(Date.now() - DAY, first.body.trip.id).run();
    expect((await createEvent(u.token)).status).toBe(201);
  });

  it("a manually revealed event frees the slot", async () => {
    const u = await signUp();
    await grantEvents(u.userId);
    const first = await createEvent(u.token);
    await env.DB.prepare("UPDATE trips SET revealed_at = ? WHERE id = ?").bind(Date.now(), first.body.trip.id).run();
    expect((await createEvent(u.token)).status).toBe(201);
  });

  it("an unrevealed regular rollo does not block an event (but it counts toward the cap of 2)", async () => {
    const u = await signUp();
    await grantEvents(u.userId);
    await createTrip(u.token);
    expect((await createEvent(u.token)).status).toBe(201);
    const third = await createEvent(u.token);
    expect(third.status).toBe(409);
  });

  it("unlimited_rollos users still get the 409 on a second unrevealed event", async () => {
    const u = await signUp();
    await grantEvents(u.userId);
    await env.DB.prepare("UPDATE users SET unlimited_rollos = 1 WHERE id = ?").bind(u.userId).run();
    expect((await createEvent(u.token)).status).toBe(201);
    const second = await createEvent(u.token);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe(ONE_AT_A_TIME);
  });

  it("two concurrent creates cannot both pass", async () => {
    const u = await signUp();
    await grantEvents(u.userId);
    const results = await Promise.all([createEvent(u.token), createEvent(u.token)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await tripCount(u.userId)).toBe(1);
  });

  it("joining someone else's event does not count", async () => {
    const org = await signUp();
    await grantEvents(org.userId);
    const { body } = await createEvent(org.token);
    const guest = await signUp();
    await grantEvents(guest.userId);
    const [g] = (await api("GET", `/trips/${body.trip.id}`, { token: org.token })).body.trip.groups as { id: string }[];
    await api("POST", "/trips/join", { token: guest.token, body: { code: body.trip.joinCode, groupIds: [g!.id] } });
    expect((await createEvent(guest.token)).status).toBe(201);
  });
});

describe("canCreateEvents in GET /me", () => {
  it("false by default, true once granted", async () => {
    const u = await signUp();
    expect((await api("GET", "/me", { token: u.token })).body.canCreateEvents).toBe(false);
    await grantEvents(u.userId);
    expect((await api("GET", "/me", { token: u.token })).body.canCreateEvents).toBe(true);
  });
});

describe("PATCH /admin/users/{id} canCreateEvents", () => {
  const patch = (id: string, token: string, body: unknown) => api("PATCH", `/admin/users/${id}`, { token, body });

  it("a superadmin enables it, the detail shows it and the user can create events", async () => {
    const su = await makeSuperadmin();
    const u = await signUp();
    expect((await api("GET", `/admin/users/${u.userId}`, { token: su.token })).body.canCreateEvents).toBe(false);
    expect((await createEvent(u.token)).status).toBe(403);
    const r = await patch(u.userId, su.token, { canCreateEvents: true });
    expect(r.status).toBe(200);
    expect(r.body.canCreateEvents).toBe(true);
    expect((await api("GET", `/admin/users/${u.userId}`, { token: su.token })).body.canCreateEvents).toBe(true);
    expect((await createEvent(u.token)).status).toBe(201);
    expect((await patch(u.userId, su.token, { canCreateEvents: false })).body.canCreateEvents).toBe(false);
  });

  it("is session-only: the admin token gets 404", async () => {
    const u = await signUp();
    const res = await api("PATCH", `/admin/users/${u.userId}`, { token: env.ADMIN_TOKEN, body: { canCreateEvents: true } });
    expect(res.status).toBe(404);
  });

  it("a non-boolean value is a 400", async () => {
    const su = await makeSuperadmin();
    const u = await signUp();
    expect((await patch(u.userId, su.token, { canCreateEvents: "si" })).status).toBe(400);
  });
});
