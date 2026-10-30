import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { localDate } from "../src/lib/util";
import { api, DAY, HOUR, joinAs, MINUTE, newTrip, TZ } from "./helpers";

const now = () => Date.now();

/** A rollo with a plain admin (not the creator) who edits it. */
async function setup(dates: { startsAt: number; endsAt: number; revealAt: number }, extra: Record<string, unknown> = {}) {
  const fx = await newTrip({ ...dates, ...extra });
  const admin = await joinAs(fx.code, "Ana");
  const promoted = await api("POST", `/trips/${fx.tripId}/members/${admin.memberId}/admin`, { token: fx.adminToken });
  expect(promoted.status).toBe(200);
  const patch = (body: unknown, token = admin.token) => api("PATCH", `/trips/${fx.tripId}`, { token, body });
  const get = async () => (await api("GET", `/trips/${fx.tripId}`, { token: fx.adminToken })).body.trip;
  return { fx, admin, patch, get };
}

const upcoming = () => ({ startsAt: now() + 2 * DAY, endsAt: now() + 5 * DAY, revealAt: now() + 6 * DAY });
const active = () => ({ startsAt: now() - DAY, endsAt: now() + 5 * DAY, revealAt: now() + 6 * DAY });
const ended = () => ({ startsAt: now() - 5 * DAY, endsAt: now() - DAY, revealAt: now() + DAY });

async function seedMoment(tripId: string, userId: string, day: string, notifyAt: number) {
  await env.DB.prepare("INSERT INTO trip_moments (trip_id, user_id, day, notify_at, created_at, mode) VALUES (?, ?, ?, ?, ?, 'photo')")
    .bind(tripId, userId, day, notifyAt, now())
    .run();
}
const momentDays = async (tripId: string) =>
  (await env.DB.prepare("SELECT day FROM trip_moments WHERE trip_id = ? ORDER BY day").bind(tripId).all<{ day: string }>()).results.map((r) => r.day);

describe("PATCH /trips/:id before the start", () => {
  it("changes dates, quota mode and moment", async () => {
    const { patch, get } = await setup(upcoming());
    const startsAt = now() + 3 * DAY;
    const endsAt = now() + 8 * DAY;
    const revealAt = now() + 9 * DAY;
    const res = await patch({
      startsAt, endsAt, revealAt, photoLimitMode: "total", totalPhotoLimit: 40,
      momentMode: "photo_selfie", momentWindowStart: 600, momentWindowEnd: 1200,
    });
    expect(res.status).toBe(200);
    expect(await get()).toMatchObject({
      startsAt, endsAt, revealAt, photoLimitMode: "total", totalPhotoLimit: 40,
      momentMode: "photo_selfie", momentWindowStart: 600, momentWindowEnd: 1200,
    });
  });

  it("deletes every drawn moment when the start changes", async () => {
    const { fx, patch } = await setup({ ...upcoming(), startsAt: now() + 2 * HOUR }, { momentMode: "photo" });
    const days = [0, 1, 2].map((n) => localDate(now() + n * DAY, TZ));
    for (const d of days) await seedMoment(fx.tripId, fx.adminUserId, d, now() + 3 * HOUR);
    expect((await patch({ startsAt: now() + 4 * HOUR })).status).toBe(200);
    expect(await momentDays(fx.tripId)).toEqual([]);
  });
});

describe("PATCH /trips/:id while running", () => {
  it("refuses the start and the quota mode, keeps the rest", async () => {
    const { patch } = await setup(active());
    const start = await patch({ startsAt: now() + DAY });
    expect(start.status).toBe(409);
    expect(start.body.error).toBe("El rollo ya empezó: el inicio no se cambia");
    const mode = await patch({ photoLimitMode: "total", totalPhotoLimit: 20 });
    expect(mode.status).toBe(409);
    expect(mode.body.error).toBe("El rollo ya empezó: el tipo de cupo no se cambia");
  });

  it("changes the end, the daily quota and the moment mode", async () => {
    const { patch, get } = await setup(active());
    const endsAt = now() + 3 * DAY;
    const res = await patch({ endsAt, dailyPhotoLimit: 12, momentMode: "photo" });
    expect(res.status).toBe(200);
    expect(await get()).toMatchObject({ endsAt, dailyPhotoLimit: 12, momentMode: "photo" });
  });

  it("treats a re-sent stored value as untouched", async () => {
    const dates = active();
    const { patch, get } = await setup(dates);
    const res = await patch({ startsAt: dates.startsAt, photoLimitMode: "daily", dailyPhotoLimit: 7 });
    expect(res.status).toBe(200);
    expect((await get()).dailyPhotoLimit).toBe(7);
  });

  it("keeps today's moment and deletes tomorrow's when the end, mode or window change", async () => {
    for (const body of [{ endsAt: now() + 4 * DAY }, { momentMode: "photo_selfie" }, { momentWindowStart: 600 }]) {
      const { fx, patch } = await setup(active(), { momentMode: "photo" });
      const today = localDate(now(), TZ);
      const tomorrow = localDate(now() + DAY, TZ);
      const notifyAt = now() + 2 * HOUR;
      await seedMoment(fx.tripId, fx.adminUserId, today, notifyAt);
      await seedMoment(fx.tripId, fx.adminUserId, tomorrow, notifyAt + DAY);
      expect((await patch(body)).status).toBe(200);
      expect(await momentDays(fx.tripId)).toEqual([today]);
      const row = await env.DB.prepare("SELECT notify_at FROM trip_moments WHERE trip_id = ? AND day = ?").bind(fx.tripId, today).first<{ notify_at: number }>();
      expect(row!.notify_at).toBe(notifyAt);
    }
  });

  it("deletes nothing when only the daily quota changes", async () => {
    const { fx, patch } = await setup(active(), { momentMode: "photo" });
    const today = localDate(now(), TZ);
    const tomorrow = localDate(now() + DAY, TZ);
    await seedMoment(fx.tripId, fx.adminUserId, today, now() + HOUR);
    await seedMoment(fx.tripId, fx.adminUserId, tomorrow, now() + DAY);
    expect((await patch({ dailyPhotoLimit: 3 })).status).toBe(200);
    expect(await momentDays(fx.tripId)).toEqual([today, tomorrow]);
  });

  it("also deletes today's untaken moment when the new end leaves no room for its 15 minutes", async () => {
    const { fx, patch } = await setup(active(), { momentMode: "photo" });
    const today = localDate(now(), TZ);
    await seedMoment(fx.tripId, fx.adminUserId, today, now() + 20 * MINUTE);
    expect((await patch({ endsAt: now() + 25 * MINUTE, revealAt: now() + 2 * DAY })).status).toBe(200);
    expect(await momentDays(fx.tripId)).toEqual([]);
  });

  it("keeps a taken moment", async () => {
    const { fx, patch } = await setup(active(), { momentMode: "photo" });
    const tomorrow = localDate(now() + DAY, TZ);
    await seedMoment(fx.tripId, fx.adminUserId, tomorrow, now() + DAY);
    await env.DB.prepare("UPDATE trip_moments SET media_id = 'm1' WHERE trip_id = ?").bind(fx.tripId).run();
    expect((await patch({ momentMode: "off" })).status).toBe(200);
    expect(await momentDays(fx.tripId)).toEqual([tomorrow]);
  });
});

describe("PATCH /trips/:id once ended or revealed", () => {
  it("refuses everything but the name", async () => {
    const { patch, get } = await setup(ended());
    for (const body of [{ endsAt: now() + DAY }, { dailyPhotoLimit: 5 }, { momentMode: "photo" }, { revealAt: now() + 3 * DAY }]) {
      const res = await patch(body);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("El rollo ya terminó: no se puede editar");
    }
    expect((await patch({ name: "Nuevo" })).status).toBe(200);
    expect((await get()).name).toBe("Nuevo");
  });

  it("refuses a revealed rollo too", async () => {
    const { fx, patch } = await setup(active());
    expect((await api("POST", `/trips/${fx.tripId}/reveal`, { token: fx.adminToken })).status).toBe(200);
    expect((await patch({ dailyPhotoLimit: 5 })).status).toBe(409);
    expect((await patch({ name: "Nuevo" })).status).toBe(200);
  });
});

describe("PATCH /trips/:id validation", () => {
  it("rejects more than 31 days", async () => {
    const { patch } = await setup(upcoming());
    const res = await patch({ endsAt: now() + 40 * DAY, revealAt: now() + 41 * DAY });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("El rollo puede durar hasta 31 días");
  });

  it("lets a legacy long rollo change something else", async () => {
    const { patch } = await setup({ startsAt: now() - DAY, endsAt: now() + 39 * DAY, revealAt: now() + 40 * DAY });
    expect((await patch({ dailyPhotoLimit: 5 })).status).toBe(200);
  });

  it("rejects an end after a fixed reveal", async () => {
    const { patch } = await setup(active());
    const res = await patch({ endsAt: now() + 8 * DAY });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("El revelado no puede ser antes del fin");
  });

  it("rejects a window shorter than 30 minutes, also against the stored half", async () => {
    const { patch } = await setup(active());
    for (const body of [{ momentWindowStart: 600, momentWindowEnd: 620 }, { momentWindowStart: 1370 }]) {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("La franja del momento tiene que durar al menos 30 minutos");
    }
  });

  it("needs a total when switching to total mode", async () => {
    const { patch } = await setup(upcoming());
    const res = await patch({ photoLimitMode: "total" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Elegí cuántas fotos por persona tiene el rollo");
  });

  it("rejects a start in the past and the caps", async () => {
    const { patch } = await setup(upcoming());
    expect((await patch({ startsAt: now() - HOUR })).body.error).toBe("El inicio no puede ser en el pasado");
    expect((await patch({ dailyPhotoLimit: 31 })).status).toBe(400);
    expect((await patch({ photoLimitMode: "total", totalPhotoLimit: 201 })).status).toBe(400);
  });

  it("keeps 403 for a plain member and for a non-creator admin touching the private rollo", async () => {
    const { fx, admin, patch } = await setup(upcoming());
    const member = await joinAs(fx.code, "Beto");
    expect((await patch({ dailyPhotoLimit: 3 }, member.token)).status).toBe(403);
    const res = await patch({ featuringDisabled: true, dailyPhotoLimit: 3 }, admin.token);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Solo quien creó el rollo puede hacer esto");
    const got = (await api("GET", `/trips/${fx.tripId}`, { token: fx.adminToken })).body.trip;
    expect(got.dailyPhotoLimit).toBe(2);
  });
});

