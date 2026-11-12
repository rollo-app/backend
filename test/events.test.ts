import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { DAY, HOUR, TZ, api, createTrip, newTrip, signUp } from "./helpers";

const eventBody = (overrides: Record<string, unknown> = {}) => {
  const now = Date.now();
  return {
    name: "Casamiento",
    timezone: TZ,
    startsAt: now + HOUR,
    endsAt: now + 2 * HOUR,
    revealAt: now + 3 * HOUR,
    type: "event",
    groups: ["Familia de él", "Trabajo de ella"],
    photoLimitMode: "total",
    totalPhotoLimit: 20,
    ...overrides,
  };
};

describe("POST /trips (event)", () => {
  it("creates an event with its groups in order", async () => {
    const { token } = await signUp(undefined, "Org");
    const res = await api("POST", "/trips", { token, body: eventBody() });
    expect(res.status).toBe(201);
    expect(res.body.trip.type).toBe("event");
    expect(res.body.trip.groups.map((g: { name: string }) => g.name)).toEqual(["Familia de él", "Trabajo de ella"]);
    expect(res.body.trip.groups[0].id).toEqual(expect.any(String));
    expect(res.body.trip.coverUrl).toBeNull();
  });

  it("rejects an event without groups", async () => {
    const { token } = await signUp(undefined, "Org");
    expect((await api("POST", "/trips", { token, body: eventBody({ groups: [] }) })).status).toBe(400);
    expect((await api("POST", "/trips", { token, body: eventBody({ groups: undefined }) })).status).toBe(400);
  });

  it("rejects duplicate group names", async () => {
    const { token } = await signUp(undefined, "Org");
    const res = await api("POST", "/trips", { token, body: eventBody({ groups: ["Familia", "Familia"] }) });
    expect(res.status).toBe(400);
  });

  it("forces total photo limit and no moment on events", async () => {
    const { token } = await signUp(undefined, "Org");
    const created = await api("POST", "/trips", {
      token,
      body: eventBody({ photoLimitMode: "daily", momentMode: "photo", totalPhotoLimit: undefined }),
    });
    expect(created.status).toBe(201);
    const res = await api("GET", `/trips/${created.body.trip.id}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.trip.photoLimitMode).toBe("total");
    expect(res.body.trip.momentMode).toBe("off");
    expect(res.body.trip.totalPhotoLimit).toBe(20);
    expect(res.body.me.groupIds).toEqual([]);
  });

  it("a regular trip reports type trip and no groups", async () => {
    const { token } = await signUp(undefined, "Org");
    const { tripId } = await createTrip(token);
    const res = await api("GET", `/trips/${tripId}`, { token });
    expect(res.body.trip.type).toBe("trip");
    expect(res.body.trip.groups).toEqual([]);
    expect(res.body.trip.coverUrl).toBeNull();
  });

  it("rejects groups on a regular trip", async () => {
    const { token } = await signUp(undefined, "Org");
    const res = await api("POST", "/trips", { token, body: eventBody({ type: "trip" }) });
    expect(res.status).toBe(400);
  });

  it("my trips list carries type and cover", async () => {
    const { token } = await signUp(undefined, "Org");
    await api("POST", "/trips", { token, body: eventBody() });
    const res = await api("GET", "/me/trips", { token });
    expect(res.status).toBe(200);
    expect(res.body.trips[0]).toMatchObject({ type: "event", coverUrl: null });
  });
});

async function newEvent(overrides: Record<string, unknown> = {}) {
  const org = await signUp(undefined, "Org");
  const { tripId, code, memberId } = await createTrip(org.token, {
    type: "event",
    groups: ["Familia de él", "Trabajo de ella"],
    photoLimitMode: "total",
    totalPhotoLimit: 20,
    dailyPhotoLimit: undefined,
    dailyVideoLimit: undefined,
    ...overrides,
  });
  const detail = await api("GET", `/trips/${tripId}`, { token: org.token });
  const [a, b] = detail.body.trip.groups as { id: string; name: string }[];
  return { org, tripId, code, memberId, a: a!.id, b: b!.id };
}

const myGroups = async (tripId: string, token: string) => {
  const res = await api("GET", `/trips/${tripId}`, { token });
  return [...(res.body.me.groupIds as string[])].sort();
};

describe("GET /events/{code}", () => {
  it("previews an event by code without a session", async () => {
    const ev = await newEvent();
    const res = await api("GET", `/events/${ev.code}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Viaje al sur", coverUrl: null, revealed: false });
    expect(res.body.groups.map((g: { name: string }) => g.name)).toEqual(["Familia de él", "Trabajo de ella"]);
    expect(res.body.groups[0].id).toBe(ev.a);
    // Lower case is accepted like on join.
    expect((await api("GET", `/events/${ev.code.toLowerCase()}`)).status).toBe(200);
  });

  it("answers 404 for a trip code and for an unknown code", async () => {
    const { code } = await newTrip();
    const res = await api("GET", `/events/${code}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Código inválido" });
    expect((await api("GET", "/events/ZZZZZZ")).status).toBe(404);
  });

  it("is limited by IP", async () => {
    const ev = await newEvent();
    const e = { RL_SEARCH: { limit: async () => ({ success: false }) } };
    expect((await api("GET", `/events/${ev.code}`, { env: e })).status).toBe(429);
  });
});

describe("POST /trips/join (event)", () => {
  it("joining an event without groups asks to update", async () => {
    const ev = await newEvent();
    const guest = await signUp(undefined, "Invitado");
    const res = await api("POST", "/trips/join", { token: guest.token, body: { code: ev.code } });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Actualizá Rollo para sumarte a este evento.", code: "EVENT_NEEDS_UPDATE" });
    const row = await env.DB.prepare("SELECT 1 FROM members WHERE trip_id = ? AND user_id = ?").bind(ev.tripId, guest.userId).first();
    expect(row).toBeNull();
  });

  it("an existing member rejoining without groups also asks to update", async () => {
    const ev = await newEvent();
    const guest = await signUp(undefined, "Invitado");
    await env.DB.prepare("INSERT INTO members (id, trip_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)")
      .bind(crypto.randomUUID(), ev.tripId, guest.userId, Date.now())
      .run();
    const res = await api("POST", "/trips/join", { token: guest.token, body: { code: ev.code } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVENT_NEEDS_UPDATE");
  });

  it("joins an event into the chosen groups", async () => {
    const ev = await newEvent();
    const guest = await signUp(undefined, "Invitado");
    const res = await api("POST", "/trips/join", { token: guest.token, body: { code: ev.code, groupIds: [ev.a, ev.b] } });
    expect(res.status).toBe(201);
    expect(await myGroups(ev.tripId, guest.token)).toEqual([ev.a, ev.b].sort());
  });

  it("rejects group ids from another trip", async () => {
    const ev = await newEvent();
    const other = await newEvent();
    const guest = await signUp(undefined, "Invitado");
    const res = await api("POST", "/trips/join", { token: guest.token, body: { code: ev.code, groupIds: [other.a] } });
    expect(res.status).toBe(400);
    const row = await env.DB.prepare("SELECT 1 FROM members WHERE trip_id = ? AND user_id = ?").bind(ev.tripId, guest.userId).first();
    expect(row).toBeNull();
  });

  it("rejoining with more groups adds them", async () => {
    const ev = await newEvent();
    const guest = await signUp(undefined, "Invitado");
    expect((await api("POST", "/trips/join", { token: guest.token, body: { code: ev.code, groupIds: [ev.a] } })).status).toBe(201);
    const again = await api("POST", "/trips/join", { token: guest.token, body: { code: ev.code, groupIds: [ev.b] } });
    expect(again.status).toBe(200);
    expect(await myGroups(ev.tripId, guest.token)).toEqual([ev.a, ev.b].sort());
  });

  it("joining a revealed event says it was revealed", async () => {
    const ev = await newEvent();
    await env.DB.prepare("UPDATE trips SET reveal_at = ? WHERE id = ?").bind(Date.now() - DAY, ev.tripId).run();
    const guest = await signUp(undefined, "Invitado");
    const res = await api("POST", "/trips/join", { token: guest.token, body: { code: ev.code, groupIds: [ev.a] } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Este evento ya se reveló.");
  });

  it("a full event adds neither the member nor their groups", async () => {
    const ev = await newEvent();
    await env.DB.prepare("UPDATE trips SET max_members = 1 WHERE id = ?").bind(ev.tripId).run();
    const guest = await signUp(undefined, "Invitado");
    const res = await api("POST", "/trips/join", { token: guest.token, body: { code: ev.code, groupIds: [ev.a] } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Este rollo está lleno. Pedile a quien lo creó que haga lugar.");
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM member_groups WHERE group_id = ?").bind(ev.a).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it("a regular trip ignores groupIds", async () => {
    const { code, tripId } = await newTrip();
    const guest = await signUp(undefined, "Invitado");
    const res = await api("POST", "/trips/join", { token: guest.token, body: { code, groupIds: [crypto.randomUUID()] } });
    expect(res.status).toBe(201);
    expect(await myGroups(tripId, guest.token)).toEqual([]);
  });
});

describe("event members", () => {
  it("adding friends to an event is refused", async () => {
    const ev = await newEvent();
    const friend = await signUp(undefined, "Amigo");
    const res = await api("POST", `/trips/${ev.tripId}/members`, { token: ev.org.token, body: { friendIds: [friend.userId] } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("En un evento se entra con el código.");
  });

  it("a guest can set their groups but not to none", async () => {
    const ev = await newEvent();
    const guest = await signUp(undefined, "Invitado");
    await api("POST", "/trips/join", { token: guest.token, body: { code: ev.code, groupIds: [ev.a] } });
    const ok = await api("PUT", `/trips/${ev.tripId}/members/me/groups`, { token: guest.token, body: { groupIds: [ev.b] } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ groupIds: [ev.b] });
    expect(await myGroups(ev.tripId, guest.token)).toEqual([ev.b]);
    expect((await api("PUT", `/trips/${ev.tripId}/members/me/groups`, { token: guest.token, body: { groupIds: [] } })).status).toBe(400);
    expect((await api("PUT", `/trips/${ev.tripId}/members/me/groups`, { token: guest.token, body: { groupIds: [crypto.randomUUID()] } })).status).toBe(400);
  });

  it("an organizer may have no groups", async () => {
    const ev = await newEvent();
    const res = await api("PUT", `/trips/${ev.tripId}/members/me/groups`, { token: ev.org.token, body: { groupIds: [] } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groupIds: [] });
  });

  it("changing groups after the reveal is refused", async () => {
    const ev = await newEvent();
    const guest = await signUp(undefined, "Invitado");
    await api("POST", "/trips/join", { token: guest.token, body: { code: ev.code, groupIds: [ev.a] } });
    await env.DB.prepare("UPDATE trips SET reveal_at = ? WHERE id = ?").bind(Date.now() - DAY, ev.tripId).run();
    for (const token of [guest.token, ev.org.token]) {
      const res = await api("PUT", `/trips/${ev.tripId}/members/me/groups`, { token, body: { groupIds: [ev.b] } });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Este evento ya se reveló.");
    }
    expect(await myGroups(ev.tripId, guest.token)).toEqual([ev.a]);
  });

  it("setting groups on a regular trip is refused", async () => {
    const { tripId, adminToken } = await newTrip();
    const res = await api("PUT", `/trips/${tripId}/members/me/groups`, { token: adminToken, body: { groupIds: [] } });
    expect(res.status).toBe(409);
  });
});
