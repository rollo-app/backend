import { describe, expect, it } from "vitest";
import { api, createTrip, DAY, join, TZ, uploadMedia } from "./helpers";

describe("POST /trips", () => {
  it("crea el viaje y devuelve código y token de admin", async () => {
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

  it("rechaza una zona horaria inválida", async () => {
    const res = await api("POST", "/trips", {
      body: { name: "x", adminName: "a", timezone: "Mars/Base", startsAt: 1, endsAt: 2, revealAt: 2 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/zona horaria/);
  });

  it("rechaza un viaje que termina antes de empezar", async () => {
    const res = await api("POST", "/trips", {
      body: { name: "x", adminName: "a", timezone: TZ, startsAt: 10, endsAt: 5, revealAt: 10 },
    });
    expect(res.status).toBe(400);
  });

  it("rechaza un revelado anterior al inicio", async () => {
    const res = await api("POST", "/trips", {
      body: { name: "x", adminName: "a", timezone: TZ, startsAt: 10, endsAt: 20, revealAt: 5 },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /trips/join", () => {
  it("se une con el código, sin importar mayúsculas", async () => {
    const { code } = await createTrip();
    const res = await api("POST", "/trips/join", { body: { code: code.toLowerCase(), name: "Fede" } });
    expect(res.status).toBe(201);
    expect(res.body.member).toMatchObject({ name: "Fede", role: "member" });
  });

  it("rechaza un código inexistente", async () => {
    await createTrip();
    const res = await api("POST", "/trips/join", { body: { code: "ZZZZZZ", name: "Fede" } });
    expect(res.status).toBe(404);
  });

  it("no permite dos personas con el mismo nombre (ignora mayúsculas)", async () => {
    const { code } = await createTrip();
    await join(code, "Fede");
    const res = await api("POST", "/trips/join", { body: { code, name: "fede" } });
    expect(res.status).toBe(409);
  });

  it("no deja unirse a un rollo ya revelado", async () => {
    const { code, tripId, adminToken } = await createTrip();
    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    const res = await api("POST", "/trips/join", { body: { code, name: "Tarde" } });
    expect(res.status).toBe(409);
  });
});

describe("autenticación", () => {
  it("pide token", async () => {
    const { tripId } = await createTrip();
    expect((await api("GET", `/trips/${tripId}`)).status).toBe(401);
  });

  it("rechaza tokens inválidos", async () => {
    const { tripId } = await createTrip();
    expect((await api("GET", `/trips/${tripId}`, { token: "inventado" })).status).toBe(401);
  });

  it("un token de otro viaje no sirve", async () => {
    const a = await createTrip();
    const b = await createTrip();
    expect((await api("GET", `/trips/${a.tripId}`, { token: b.adminToken })).status).toBe(403);
  });
});

describe("GET /trips/:id", () => {
  it("devuelve miembros y lo que queda del rollo hoy", async () => {
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
  it("el admin cambia límites y fecha de revelado", async () => {
    const { tripId, adminToken } = await createTrip();
    const revealAt = Date.now() + 20 * DAY;
    const res = await api("PATCH", `/trips/${tripId}`, {
      token: adminToken,
      body: { dailyPhotoLimit: 24, revealAt },
    });
    expect(res.status).toBe(200);
    expect(res.body.trip).toMatchObject({ dailyPhotoLimit: 24, revealAt });
  });

  it("un miembro no puede editar", async () => {
    const { tripId, code } = await createTrip();
    const fede = await join(code, "Fede");
    const res = await api("PATCH", `/trips/${tripId}`, { token: fede.token, body: { dailyPhotoLimit: 99 } });
    expect(res.status).toBe(403);
  });
});

describe("revelado", () => {
  it("solo el admin puede revelar", async () => {
    const { tripId, code } = await createTrip();
    const fede = await join(code, "Fede");
    expect((await api("POST", `/trips/${tripId}/reveal`, { token: fede.token })).status).toBe(403);
  });

  it("el admin revela antes de tiempo", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.trip.revealed).toBe(true);
  });

  it("se revela solo cuando pasa revealAt", async () => {
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
  it("el admin saca a alguien y su token deja de servir", async () => {
    const { tripId, code, adminToken } = await createTrip();
    const fede = await join(code, "Fede");

    const res = await api("DELETE", `/trips/${tripId}/members/${fede.memberId}`, { token: adminToken });
    expect(res.status).toBe(204);
    expect((await api("GET", `/trips/${tripId}`, { token: fede.token })).status).toBe(401);
  });

  it("libera el nombre para que vuelva a entrar", async () => {
    const { tripId, code, adminToken } = await createTrip();
    const fede = await join(code, "Fede");
    await api("DELETE", `/trips/${tripId}/members/${fede.memberId}`, { token: adminToken });
    expect((await api("POST", "/trips/join", { body: { code, name: "Fede" } })).status).toBe(201);
  });

  it("el admin no se puede sacar a sí mismo", async () => {
    const { tripId, adminToken, adminId } = await createTrip();
    expect((await api("DELETE", `/trips/${tripId}/members/${adminId}`, { token: adminToken })).status).toBe(400);
  });
});

describe("PATCH /trips/:id/members/me", () => {
  it("cambia tu propio nombre y devuelve el miembro", async () => {
    const { tripId, code } = await createTrip();
    const fede = await join(code, "Fede");
    const res = await api("PATCH", `/trips/${tripId}/members/me`, { token: fede.token, body: { name: "  Fede G  " } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: fede.memberId, name: "Fede G", role: "member" });

    const detail = await api("GET", `/trips/${tripId}`, { token: fede.token });
    expect(detail.body.me.name).toBe("Fede G");
  });

  it("409 si el nombre ya lo usa otro (sin distinguir mayúsculas)", async () => {
    const { tripId, code } = await createTrip();
    const fede = await join(code, "Fede");
    const res = await api("PATCH", `/trips/${tripId}/members/me`, { token: fede.token, body: { name: "juani" } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Ya hay alguien con ese nombre en el viaje");
  });

  it("deja cambiar solo mayúsculas de tu propio nombre", async () => {
    const { tripId, adminToken } = await createTrip();
    const res = await api("PATCH", `/trips/${tripId}/members/me`, { token: adminToken, body: { name: "JUANI" } });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("JUANI");
    expect(res.body.role).toBe("admin");
  });

  it("400 si el nombre es inválido", async () => {
    const { tripId, adminToken } = await createTrip();
    for (const name of ["   ", "x".repeat(31)]) {
      const res = await api("PATCH", `/trips/${tripId}/members/me`, { token: adminToken, body: { name } });
      expect(res.status).toBe(400);
    }
  });

  it("no podés editar en un viaje que no es tuyo", async () => {
    const a = await createTrip();
    const b = await createTrip();
    const res = await api("PATCH", `/trips/${b.tripId}/members/me`, { token: a.adminToken, body: { name: "Otro" } });
    expect(res.status).toBe(403);
  });
});
