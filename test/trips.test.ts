import { describe, expect, it } from "vitest";
import { api, createTrip, DAY, join, MINUTE, TZ, uploadMedia } from "./helpers";

describe("POST /trips", () => {
  it("creates the trip and returns the code and admin token", async () => {
    const now = Date.now();
    const res = await api("POST", "/trips", {
      body: {
        name: "Viaje al sur",
        adminName: "Juani",
        timezone: TZ,
        startsAt: now,
        endsAt: now + 10 * DAY,
        revealAt: now + 11 * DAY,
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.trip).toMatchObject({
      name: "Viaje al sur",
      revealed: false,
      dailyPhotoLimit: 10,
      dailyVideoLimit: 3,
    });
    expect(res.body.trip.joinCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(res.body.member).toMatchObject({ name: "Juani", role: "admin" });
    expect(res.body.token).toEqual(expect.any(String));
  });

  it("rejects an invalid time zone", async () => {
    const res = await api("POST", "/trips", {
      body: { name: "x", adminName: "a", timezone: "Mars/Base", startsAt: 1, endsAt: 2, revealAt: 2 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Zona horaria inválida/);
  });

  it("rejects a trip that ends before it starts", async () => {
    const now = Date.now();
    const res = await api("POST", "/trips", {
      body: { name: "x", adminName: "a", timezone: TZ, startsAt: now + 10, endsAt: now + 5, revealAt: now + 10 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("El rollo tiene que terminar después de empezar");
  });

  it("rejects a reveal before the end", async () => {
    const now = Date.now();
    const res = await api("POST", "/trips", {
      body: { name: "x", adminName: "a", timezone: TZ, startsAt: now + 10, endsAt: now + 20, revealAt: now + 15 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/El revelado no puede ser antes del fin/);
  });

  it("accepts a reveal exactly at the end", async () => {
    const now = Date.now();
    const res = await api("POST", "/trips", {
      body: { name: "x", adminName: "a", timezone: TZ, startsAt: now + 10, endsAt: now + 20, revealAt: now + 20 },
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /trips (dates in the past)", () => {
  const create = (startsAt: number) =>
    api("POST", "/trips", {
      body: { name: "x", adminName: "a", timezone: TZ, startsAt, endsAt: Date.now() + 5 * DAY, revealAt: Date.now() + 6 * DAY },
    });

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
  it("joins with the code, case-insensitively", async () => {
    const { code } = await createTrip();
    const res = await api("POST", "/trips/join", { body: { code: code.toLowerCase(), name: "Fede" } });
    expect(res.status).toBe(201);
    expect(res.body.member).toMatchObject({ name: "Fede", role: "member" });
  });

  it("rejects a nonexistent code", async () => {
    await createTrip();
    const res = await api("POST", "/trips/join", { body: { code: "ZZZZZZ", name: "Fede" } });
    expect(res.status).toBe(404);
  });

  it("doesn't allow two people with the same name (case-insensitive)", async () => {
    const { code } = await createTrip();
    await join(code, "Fede");
    const res = await api("POST", "/trips/join", { body: { code, name: "fede" } });
    expect(res.status).toBe(409);
  });

  it("doesn't allow joining an already revealed roll", async () => {
    const { code, tripId, adminToken } = await createTrip();
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    const res = await api("POST", "/trips/join", { body: { code, name: "Tarde" } });
    expect(res.status).toBe(409);
  });
});

describe("authentication", () => {
  it("requires a token", async () => {
    const { tripId } = await createTrip();
    expect((await api("GET", `/trips/${tripId}`)).status).toBe(401);
  });

  it("rejects invalid tokens", async () => {
    const { tripId } = await createTrip();
    expect((await api("GET", `/trips/${tripId}`, { token: "inventado" })).status).toBe(401);
  });

  it("a token from another trip doesn't work", async () => {
    const a = await createTrip();
    const b = await createTrip();
    expect((await api("GET", `/trips/${a.tripId}`, { token: b.adminToken })).status).toBe(403);
  });
});

describe("GET /trips/:id", () => {
  it("returns members and what is left of the roll today", async () => {
    const { tripId, code } = await createTrip();
    const fede = await join(code, "Fede");
    await uploadMedia(tripId, fede.token);

    const res = await api("GET", `/trips/${tripId}`, { token: fede.token });
    expect(res.status).toBe(200);
    expect(res.body.me).toMatchObject({ name: "Fede", role: "member" });
    expect(res.body.members.map((m: { name: string }) => m.name)).toEqual(["Juani", "Fede"]);
    expect(res.body.today).toMatchObject({ photosLeft: 1, videosLeft: 1 });
    expect(res.body.totalUploaded).toBe(1);
  });
});

describe("PATCH /trips/:id", () => {
  it("the admin changes limits and reveal date", async () => {
    const { tripId, adminToken } = await createTrip();
    const revealAt = Date.now() + 20 * DAY;
    const res = await api("PATCH", `/trips/${tripId}`, {
      token: adminToken,
      body: { dailyPhotoLimit: 24, revealAt },
    });
    expect(res.status).toBe(200);
    expect(res.body.trip).toMatchObject({ dailyPhotoLimit: 24, revealAt });
  });

  it("rejects moving the reveal before the existing end", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("PATCH", `/trips/${tripId}`, { token: adminToken, body: { revealAt: Date.now() + 2 * DAY } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/El revelado no puede ser antes del fin/);
  });

  it("rejects moving the end after the existing reveal", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("PATCH", `/trips/${tripId}`, { token: adminToken, body: { endsAt: Date.now() + 15 * DAY } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/El revelado no puede ser antes del fin/);
  });

  it("moves the end and the reveal together further out", async () => {
    const { tripId, adminToken } = await createTrip();
    const endsAt = Date.now() + 15 * DAY;
    const revealAt = Date.now() + 16 * DAY;
    const res = await api("PATCH", `/trips/${tripId}`, { token: adminToken, body: { endsAt, revealAt } });
    expect(res.status).toBe(200);
    expect(res.body.trip).toMatchObject({ endsAt, revealAt });
  });

  it("rejects an end in the past", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("PATCH", `/trips/${tripId}`, { token: adminToken, body: { endsAt: Date.now() - 6 * MINUTE } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "El fin no puede ser en el pasado" });
  });

  it("rejects a reveal in the past", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("PATCH", `/trips/${tripId}`, { token: adminToken, body: { revealAt: Date.now() - 6 * MINUTE } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "El revelado no puede ser en el pasado" });
  });

  it("doesn't validate fields that aren't sent: a trip that already started can still be edited", async () => {
    const { tripId, adminToken } = await createTrip(); // started yesterday
    const res = await api("PATCH", `/trips/${tripId}`, { token: adminToken, body: { name: "Otro nombre" } });
    expect(res.status).toBe(200);
  });

  it("a member can't edit", async () => {
    const { tripId, code } = await createTrip();
    const fede = await join(code, "Fede");
    const res = await api("PATCH", `/trips/${tripId}`, { token: fede.token, body: { dailyPhotoLimit: 99 } });
    expect(res.status).toBe(403);
  });
});

describe("reveal", () => {
  it("only the admin can reveal", async () => {
    const { tripId, code } = await createTrip();
    const fede = await join(code, "Fede");
    expect((await api("POST", `/trips/${tripId}/reveal`, { token: fede.token })).status).toBe(403);
  });

  it("the admin reveals early", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.trip.revealed).toBe(true);
  });

  it("reveals on its own once revealAt passes", async () => {
    const now = Date.now();
    const { tripId, adminToken } = await createTrip({
      startsAt: now - 3 * DAY,
      endsAt: now - DAY,
      revealAt: now - 1000,
    });
    const res = await api("GET", `/trips/${tripId}`, { token: adminToken });
    expect(res.body.trip.revealed).toBe(true);
  });
});

describe("DELETE /trips/:id/members/:memberId", () => {
  it("the admin removes someone and their token stops working", async () => {
    const { tripId, code, adminToken } = await createTrip();
    const fede = await join(code, "Fede");

    const res = await api("DELETE", `/trips/${tripId}/members/${fede.memberId}`, { token: adminToken });
    expect(res.status).toBe(204);
    expect((await api("GET", `/trips/${tripId}`, { token: fede.token })).status).toBe(401);
  });

  it("frees the name so they can join again", async () => {
    const { tripId, code, adminToken } = await createTrip();
    const fede = await join(code, "Fede");
    await api("DELETE", `/trips/${tripId}/members/${fede.memberId}`, { token: adminToken });
    expect((await api("POST", "/trips/join", { body: { code, name: "Fede" } })).status).toBe(201);
  });

  it("the admin can't remove themselves", async () => {
    const { tripId, adminToken, adminId } = await createTrip();
    expect((await api("DELETE", `/trips/${tripId}/members/${adminId}`, { token: adminToken })).status).toBe(400);
  });
});

describe("PATCH /trips/:id/members/me", () => {
  it("changes your own name and returns the member", async () => {
    const { tripId, code } = await createTrip();
    const fede = await join(code, "Fede");
    const res = await api("PATCH", `/trips/${tripId}/members/me`, { token: fede.token, body: { name: "  Fede G  " } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: fede.memberId, name: "Fede G", role: "member" });

    const detail = await api("GET", `/trips/${tripId}`, { token: fede.token });
    expect(detail.body.me.name).toBe("Fede G");
  });

  it("409 if the name is already taken by someone else (case-insensitive)", async () => {
    const { tripId, code } = await createTrip();
    const fede = await join(code, "Fede");
    const res = await api("PATCH", `/trips/${tripId}/members/me`, { token: fede.token, body: { name: "juani" } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Ya hay alguien con ese nombre en el rollo");
  });

  it("lets you change only the case of your own name", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("PATCH", `/trips/${tripId}/members/me`, { token: adminToken, body: { name: "JUANI" } });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("JUANI");
    expect(res.body.role).toBe("admin");
  });

  it("400 if the name is invalid", async () => {
    const { tripId, adminToken } = await createTrip();
    for (const name of ["   ", "x".repeat(31)]) {
      const res = await api("PATCH", `/trips/${tripId}/members/me`, { token: adminToken, body: { name } });
      expect(res.status).toBe(400);
    }
  });

  it("you can't edit in a trip that isn't yours", async () => {
    const a = await createTrip();
    const b = await createTrip();
    const res = await api("PATCH", `/trips/${b.tripId}/members/me`, { token: a.adminToken, body: { name: "Otro" } });
    expect(res.status).toBe(403);
  });
});
