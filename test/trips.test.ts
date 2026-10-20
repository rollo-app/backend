import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, createTrip, DAY, HOUR, join, joinAs, MINUTE, newTrip, signUp, TZ, uploadMedia } from "./helpers";

const tripBody = (now = Date.now()) => ({
  name: "Viaje al sur",
  timezone: TZ,
  startsAt: now,
  endsAt: now + 10 * DAY,
  revealAt: now + 11 * DAY,
});

describe("POST /trips", () => {
  it("creates the trip and returns the code and the admin membership", async () => {
    const { token, userId } = await signUp(undefined, "Juani");
    const res = await api("POST", "/trips", { token, body: tripBody() });

    expect(res.status).toBe(201);
    expect(res.body.trip).toMatchObject({
      name: "Viaje al sur",
      revealed: false,
      dailyPhotoLimit: 10,
      dailyVideoLimit: 3,
    });
    expect(res.body.trip.joinCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(res.body.member).toMatchObject({ userId, name: "Juani", avatarUrl: null, role: "admin" });
    expect(res.body).not.toHaveProperty("token");
  });

  it("requires a session", async () => {
    expect((await api("POST", "/trips", { body: tripBody() })).status).toBe(401);
  });

  it("requires the profile to have a name", async () => {
    const { token } = await signUp(undefined, null);
    const res = await api("POST", "/trips", { token, body: tripBody() });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Completá tu nombre en el perfil" });
  });

  it("rejects an invalid time zone", async () => {
    const { token } = await signUp();
    const res = await api("POST", "/trips", {
      token,
      body: { name: "x", timezone: "Mars/Base", startsAt: 1, endsAt: 2, revealAt: 2 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Zona horaria inválida/);
  });

  it("rejects a trip that ends before it starts", async () => {
    const { token } = await signUp();
    const now = Date.now();
    const res = await api("POST", "/trips", {
      token,
      body: { name: "x", timezone: TZ, startsAt: now + 10, endsAt: now + 5, revealAt: now + 10 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("El rollo tiene que terminar después de empezar");
  });

  it("rejects a reveal before the end", async () => {
    const { token } = await signUp();
    const now = Date.now();
    const res = await api("POST", "/trips", {
      token,
      body: { name: "x", timezone: TZ, startsAt: now + 10, endsAt: now + 20, revealAt: now + 15 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/El revelado no puede ser antes del fin/);
  });

  it("accepts a reveal exactly at the end", async () => {
    const { token } = await signUp();
    const now = Date.now();
    const res = await api("POST", "/trips", {
      token,
      body: { name: "x", timezone: TZ, startsAt: now + 10, endsAt: now + 20, revealAt: now + 20 },
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /trips (dates in the past)", () => {
  const create = async (startsAt: number) => {
    const { token } = await signUp();
    return api("POST", "/trips", {
      token,
      body: { name: "x", timezone: TZ, startsAt, endsAt: Date.now() + 5 * DAY, revealAt: Date.now() + 6 * DAY },
    });
  };

  it("rejects a start in the past with exactly the clear message", async () => {
    const res = await create(Date.now() - DAY);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "El inicio no puede ser en el pasado" });
  });

  it("tolerates a start up to 5 minutes in the past", async () => {
    expect((await create(Date.now() - 4 * MINUTE)).status).toBe(201);
  });

  it("rejects a start more than 5 minutes in the past", async () => {
    expect((await create(Date.now() - 6 * MINUTE)).status).toBe(400);
  });
});

describe("POST /trips/join", () => {
  it("joins with the code, case-insensitively, using the profile name", async () => {
    const { code } = await newTrip();
    const fede = await signUp(undefined, "Fede");
    const res = await api("POST", "/trips/join", { token: fede.token, body: { code: code.toLowerCase() } });
    expect(res.status).toBe(201);
    expect(res.body.member).toMatchObject({ userId: fede.userId, name: "Fede", role: "member" });
    expect(res.body).not.toHaveProperty("token");
  });

  it("rejects a nonexistent code", async () => {
    await newTrip();
    const { token } = await signUp();
    const res = await api("POST", "/trips/join", { token, body: { code: "ZZZZZZ" } });
    expect(res.status).toBe(404);
  });

  it("requires a session", async () => {
    const { code } = await newTrip();
    expect((await api("POST", "/trips/join", { body: { code } })).status).toBe(401);
  });

  it("requires the profile to have a name", async () => {
    const { code } = await newTrip();
    const { token } = await signUp(undefined, null);
    const res = await api("POST", "/trips/join", { token, body: { code } });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Completá tu nombre en el perfil" });
  });

  it("is idempotent: joining twice returns 200 with the same membership", async () => {
    const { code, tripId } = await newTrip();
    const { token } = await signUp(undefined, "Fede");
    const first = await api("POST", "/trips/join", { token, body: { code } });
    const second = await api("POST", "/trips/join", { token, body: { code } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.member).toEqual(first.body.member);

    const detail = await api("GET", `/trips/${tripId}`, { token });
    expect(detail.body.members).toHaveLength(2);
  });

  it("the admin joining their own trip with the code gets 200", async () => {
    const { code, adminToken, adminId } = await newTrip();
    const res = await api("POST", "/trips/join", { token: adminToken, body: { code } });
    expect(res.status).toBe(200);
    expect(res.body.member).toMatchObject({ id: adminId, role: "admin" });
  });

  it("two people can share the same name", async () => {
    const { code } = await newTrip();
    await joinAs(code, "Fede");
    const res = await api("POST", "/trips/join", { token: (await signUp(undefined, "fede")).token, body: { code } });
    expect(res.status).toBe(201);
  });

  it("someone removed by the admin can't rejoin", async () => {
    const { tripId, code, adminToken } = await newTrip();
    const fede = await joinAs(code, "Fede");
    await api("DELETE", `/trips/${tripId}/members/${fede.memberId}`, { token: adminToken });

    const res = await api("POST", "/trips/join", { token: fede.token, body: { code } });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "El admin te sacó de este rollo" });
  });

  it("doesn't allow joining an already revealed roll", async () => {
    const { code, tripId, adminToken } = await newTrip();
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    const { token } = await signUp(undefined, "Tarde");
    const res = await api("POST", "/trips/join", { token, body: { code } });
    expect(res.status).toBe(409);
  });

  it("an existing member still gets 200 after the reveal", async () => {
    const { code, tripId, adminToken } = await newTrip();
    const fede = await joinAs(code, "Fede");
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    expect((await api("POST", "/trips/join", { token: fede.token, body: { code } })).status).toBe(200);
  });
});

describe("authentication and access", () => {
  it("requires a token", async () => {
    const { tripId } = await newTrip();
    expect((await api("GET", `/trips/${tripId}`)).status).toBe(401);
  });

  it("rejects invalid tokens", async () => {
    const { tripId } = await newTrip();
    expect((await api("GET", `/trips/${tripId}`, { token: "inventado" })).status).toBe(401);
  });

  it("a user who is not a member of the trip gets 403", async () => {
    const a = await newTrip();
    const b = await newTrip();
    const res = await api("GET", `/trips/${a.tripId}`, { token: b.adminToken });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "No sos parte de este rollo" });
  });

  it("a trip that doesn't exist gives 404", async () => {
    const { token } = await signUp();
    const res = await api("GET", `/trips/${crypto.randomUUID()}`, { token });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Rollo no encontrado" });
  });

  it("the same account works in several trips", async () => {
    const a = await newTrip();
    const b = await newTrip();
    await join(a.code, b.adminToken);
    expect((await api("GET", `/trips/${a.tripId}`, { token: b.adminToken })).status).toBe(200);
    expect((await api("GET", `/trips/${b.tripId}`, { token: b.adminToken })).status).toBe(200);
  });
});

describe("GET /me/trips", () => {
  it("lists the user's rollos, most recent start first, with role and uploads", async () => {
    const { token } = await signUp(undefined, "Juani");
    const older = await createTrip(token, { name: "Viejo", startsAt: Date.now() - 5 * DAY });
    const newer = await createTrip(token, { name: "Nuevo", startsAt: Date.now() - 2 * DAY });
    await uploadMedia(newer.tripId, token);

    const other = await newTrip();
    await join(other.code, token);

    const res = await api("GET", "/me/trips", { token });
    expect(res.status).toBe(200);
    expect(res.body.trips.map((t: { name: string }) => t.name)).toEqual(["Viaje al sur", "Nuevo", "Viejo"]);
    expect(res.body.trips[1]).toMatchObject({
      id: newer.tripId,
      joinCode: newer.code,
      revealed: false,
      role: "admin",
      totalUploaded: 1,
    });
    expect(res.body.trips[0]).toMatchObject({ id: other.tripId, role: "member", totalUploaded: 0 });
    expect(res.body.trips[2].id).toBe(older.tripId);
    expect(res.body.trips[1]).toEqual(
      expect.objectContaining({ startsAt: expect.any(Number), endsAt: expect.any(Number), revealAt: expect.any(Number) }),
    );
  });

  it("doesn't include other people's rollos or the ones you were removed from", async () => {
    const mine = await newTrip();
    const theirs = await newTrip();
    const fede = await joinAs(mine.code, "Fede");
    await api("DELETE", `/trips/${mine.tripId}/members/${fede.memberId}`, { token: mine.adminToken });

    expect((await api("GET", "/me/trips", { token: fede.token })).body.trips).toEqual([]);
    const own = await api("GET", "/me/trips", { token: theirs.adminToken });
    expect(own.body.trips.map((t: { id: string }) => t.id)).toEqual([theirs.tripId]);
  });

  it("is empty for a new user and requires a session", async () => {
    const { token } = await signUp();
    expect((await api("GET", "/me/trips", { token })).body).toEqual({ trips: [] });
    expect((await api("GET", "/me/trips")).status).toBe(401);
  });

  it("marks revealed rollos", async () => {
    const { tripId, adminToken } = await newTrip();
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    const res = await api("GET", "/me/trips", { token: adminToken });
    expect(res.body.trips[0].revealed).toBe(true);
  });
});

describe("GET /trips/:id", () => {
  it("returns members and what is left of the roll today", async () => {
    const { tripId, code } = await newTrip();
    const fede = await joinAs(code, "Fede");
    await uploadMedia(tripId, fede.token);

    const res = await api("GET", `/trips/${tripId}`, { token: fede.token });
    expect(res.status).toBe(200);
    expect(res.body.me).toMatchObject({ name: "Fede", role: "member" });
    expect(res.body.members.map((m: { name: string }) => m.name)).toEqual(["Juani", "Fede"]);
    expect(res.body.today).toMatchObject({ photosLeft: 1, videosLeft: 1 });
    expect(res.body.totalUploaded).toBe(1);
  });

  it("has nothing left today before the rollo starts", async () => {
    const { tripId, adminToken } = await newTrip({ startsAt: Date.now() + DAY, endsAt: Date.now() + 5 * DAY });
    const res = await api("GET", `/trips/${tripId}`, { token: adminToken });
    expect(res.body.today).toMatchObject({ photosLeft: 0, videosLeft: 0 });
  });

  it("has nothing left today after the rollo ended", async () => {
    const { tripId, adminToken } = await newTrip({
      startsAt: Date.now() - 3 * DAY,
      endsAt: Date.now() - HOUR,
      revealAt: Date.now() + DAY,
    });
    const res = await api("GET", `/trips/${tripId}`, { token: adminToken });
    expect(res.body.today).toMatchObject({ photosLeft: 0, videosLeft: 0 });
  });

  it("has nothing left today once revealed", async () => {
    const { tripId, adminToken } = await newTrip();
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    const res = await api("GET", `/trips/${tripId}`, { token: adminToken });
    expect(res.body.today).toMatchObject({ photosLeft: 0, videosLeft: 0 });
  });
});

describe("PATCH /trips/:id", () => {
  it("the admin changes limits and reveal date", async () => {
    const { tripId, adminToken } = await newTrip();
    const revealAt = Date.now() + 20 * DAY;
    const res = await api("PATCH", `/trips/${tripId}`, {
      token: adminToken,
      body: { dailyPhotoLimit: 24, revealAt },
    });
    expect(res.status).toBe(200);
    expect(res.body.trip).toMatchObject({ dailyPhotoLimit: 24, revealAt });
  });

  it("rejects moving the reveal before the existing end", async () => {
    const { tripId, adminToken } = await newTrip();
    const res = await api("PATCH", `/trips/${tripId}`, { token: adminToken, body: { revealAt: Date.now() + 2 * DAY } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/El revelado no puede ser antes del fin/);
  });

  it("rejects moving the end after the existing reveal", async () => {
    const { tripId, adminToken } = await newTrip();
    const res = await api("PATCH", `/trips/${tripId}`, { token: adminToken, body: { endsAt: Date.now() + 15 * DAY } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/El revelado no puede ser antes del fin/);
  });

  it("moves the end and the reveal together further out", async () => {
    const { tripId, adminToken } = await newTrip();
    const endsAt = Date.now() + 15 * DAY;
    const revealAt = Date.now() + 16 * DAY;
    const res = await api("PATCH", `/trips/${tripId}`, { token: adminToken, body: { endsAt, revealAt } });
    expect(res.status).toBe(200);
    expect(res.body.trip).toMatchObject({ endsAt, revealAt });
  });

  it("rejects an end in the past", async () => {
    const { tripId, adminToken } = await newTrip();
    const res = await api("PATCH", `/trips/${tripId}`, { token: adminToken, body: { endsAt: Date.now() - 6 * MINUTE } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "El fin no puede ser en el pasado" });
  });

  it("rejects a reveal in the past", async () => {
    const { tripId, adminToken } = await newTrip();
    const res = await api("PATCH", `/trips/${tripId}`, { token: adminToken, body: { revealAt: Date.now() - 6 * MINUTE } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "El revelado no puede ser en el pasado" });
  });

  it("doesn't validate fields that aren't sent: a trip that already started can still be edited", async () => {
    const { tripId, adminToken } = await newTrip(); // started yesterday
    const res = await api("PATCH", `/trips/${tripId}`, { token: adminToken, body: { name: "Otro nombre" } });
    expect(res.status).toBe(200);
  });

  it("a member can't edit", async () => {
    const { tripId, code } = await newTrip();
    const fede = await joinAs(code, "Fede");
    const res = await api("PATCH", `/trips/${tripId}`, { token: fede.token, body: { dailyPhotoLimit: 99 } });
    expect(res.status).toBe(403);
  });
});

describe("reveal", () => {
  it("only the admin can reveal", async () => {
    const { tripId, code } = await newTrip();
    const fede = await joinAs(code, "Fede");
    expect((await api("POST", `/trips/${tripId}/reveal`, { token: fede.token })).status).toBe(403);
  });

  it("the admin reveals early", async () => {
    const { tripId, adminToken } = await newTrip();
    const res = await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.trip.revealed).toBe(true);
  });

  it("reveals on its own once revealAt passes", async () => {
    const now = Date.now();
    const { tripId, adminToken } = await newTrip({
      startsAt: now - 3 * DAY,
      endsAt: now - DAY,
      revealAt: now - 1000,
    });
    const res = await api("GET", `/trips/${tripId}`, { token: adminToken });
    expect(res.body.trip.revealed).toBe(true);
  });
});

describe("DELETE /trips/:id/members/:memberId", () => {
  it("the admin removes someone and they lose access to the trip", async () => {
    const { tripId, code, adminToken } = await newTrip();
    const fede = await joinAs(code, "Fede");

    const res = await api("DELETE", `/trips/${tripId}/members/${fede.memberId}`, { token: adminToken });
    expect(res.status).toBe(204);
    expect((await api("GET", `/trips/${tripId}`, { token: fede.token })).status).toBe(403);
    const detail = await api("GET", `/trips/${tripId}`, { token: adminToken });
    expect(detail.body.members.map((m: { name: string }) => m.name)).toEqual(["Juani"]);
  });

  it("the removed person keeps their session and other rollos", async () => {
    const { tripId, code, adminToken } = await newTrip();
    const other = await newTrip();
    const fede = await joinAs(code, "Fede");
    await join(other.code, fede.token);
    await api("DELETE", `/trips/${tripId}/members/${fede.memberId}`, { token: adminToken });
    expect((await api("GET", `/trips/${other.tripId}`, { token: fede.token })).status).toBe(200);
  });

  it("the admin can't remove themselves", async () => {
    const { tripId, adminToken, adminId } = await newTrip();
    expect((await api("DELETE", `/trips/${tripId}/members/${adminId}`, { token: adminToken })).status).toBe(400);
  });

  it("a member can't remove anyone", async () => {
    const { tripId, code, adminId } = await newTrip();
    const fede = await joinAs(code, "Fede");
    expect((await api("DELETE", `/trips/${tripId}/members/${adminId}`, { token: fede.token })).status).toBe(403);
  });

  it("the old per-trip name endpoint no longer exists", async () => {
    const { tripId, adminToken } = await newTrip();
    const res = await api("PATCH", `/trips/${tripId}/members/me`, { token: adminToken, body: { name: "Otro" } });
    expect(res.status).toBe(404);
  });
});

describe("member shape", () => {
  it("members and me expose id, userId, name, username, avatarUrl and role", async () => {
    const { tripId, code, adminUserId } = await newTrip();
    const fede = await joinAs(code, "Fede");
    const res = await api("GET", `/trips/${tripId}`, { token: fede.token });
    expect(res.body.me).toEqual({ id: fede.memberId, userId: fede.userId, name: "Fede", username: expect.any(String), avatarUrl: null, role: "member" });
    expect(res.body.members[0]).toMatchObject({ userId: adminUserId, name: "Juani", role: "admin" });
  });

  it("avatarUrl is built from the user's avatar key", async () => {
    const { tripId, adminToken, adminUserId } = await newTrip();
    await env.DB.prepare("UPDATE users SET avatar_key = ? WHERE id = ?")
      .bind(`avatars/${adminUserId}/v1.jpg`, adminUserId)
      .run();
    const res = await api("GET", `/trips/${tripId}`, { token: adminToken });
    expect(res.body.me.avatarUrl).toBe(`/avatars/${adminUserId}/v1.jpg`);
  });

  it("a profile name change shows up in every rollo", async () => {
    const a = await newTrip();
    const b = await newTrip();
    await join(b.code, a.adminToken);
    await api("PATCH", "/me", { token: a.adminToken, body: { name: "Juani G" } });
    const inA = await api("GET", `/trips/${a.tripId}`, { token: a.adminToken });
    const inB = await api("GET", `/trips/${b.tripId}`, { token: a.adminToken });
    expect(inA.body.me.name).toBe("Juani G");
    expect(inB.body.members.map((m: { name: string }) => m.name)).toContain("Juani G");
  });
});
