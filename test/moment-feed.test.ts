import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { localDate } from "../src/lib/util";
import { DAY, MINUTE, TZ, api, joinAs, newTrip, photoBody, uploadMedia } from "./helpers";

async function fixture(overrides: Record<string, unknown> = {}) {
  const fx = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY, ...overrides });
  const notifyAt = Date.now() - 2 * MINUTE;
  const day = localDate(notifyAt, TZ);
  await env.DB.prepare("INSERT INTO trip_moments (trip_id, user_id, day, notify_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(fx.tripId, fx.adminUserId, day, notifyAt, Date.now())
    .run();
  const mainId = await uploadMedia(fx.tripId, fx.adminToken, { momentDay: day, takenAt: notifyAt + MINUTE, thumbhash: "MAIN" });
  const selfieId = await uploadMedia(fx.tripId, fx.adminToken, { pairedMediaId: mainId, thumbhash: "SELF" });
  return { ...fx, day, mainId, selfieId };
}

const feed = (tripId: string, token: string) => api("GET", `/trips/${tripId}/feed`, { token });

describe("feed with moments", () => {
  it("before the reveal: the main photo carries momentDay and a selfie without files; the selfie is not an item", async () => {
    const fx = await fixture();
    const res = await feed(fx.tripId, fx.adminToken);
    expect(res.body.revealed).toBe(false);
    expect(res.body.items.map((i: any) => i.id)).toEqual([fx.mainId]);
    const item = res.body.items[0];
    expect(item.momentDay).toBe(fx.day);
    expect(item.selfie).toMatchObject({ id: fx.selfieId, thumbhash: "SELF", files: null });
  });

  it("after the reveal: the selfie has its files and can be downloaded by id", async () => {
    const fx = await fixture();
    await api("POST", `/trips/${fx.tripId}/reveal`, { token: fx.adminToken });
    const res = await feed(fx.tripId, fx.adminToken);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].selfie).toMatchObject({
      id: fx.selfieId,
      files: {
        thumb: `/trips/${fx.tripId}/media/${fx.selfieId}/thumb`,
        original: `/trips/${fx.tripId}/media/${fx.selfieId}/original`,
      },
    });
    for (const variant of ["thumb", "original"]) {
      expect((await api("GET", `/trips/${fx.tripId}/media/${fx.selfieId}/${variant}`, { token: fx.adminToken })).status).toBe(200);
    }
  });

  it("the selfie is not downloadable before the reveal", async () => {
    const fx = await fixture();
    expect((await api("GET", `/trips/${fx.tripId}/media/${fx.selfieId}/thumb`, { token: fx.adminToken })).status).toBe(403);
  });

  it("ordinary photos have no momentDay or selfie, and a moment without selfie has selfie null", async () => {
    const fx = await newTrip({ momentMode: "photo_selfie", startsAt: Date.now() - 5 * DAY });
    const id = await uploadMedia(fx.tripId, fx.adminToken);
    const res = await feed(fx.tripId, fx.adminToken);
    expect(res.body.items.map((i: any) => i.id)).toEqual([id]);
    expect(res.body.items[0].momentDay ?? null).toBeNull();
    expect(res.body.items[0].selfie ?? null).toBeNull();
  });

  it("a selfie that is not uploaded yet or was deleted is not exposed", async () => {
    const fx = await fixture();
    await env.DB.prepare("UPDATE media SET deleted_at = ? WHERE id = ?").bind(Date.now(), fx.selfieId).run();
    const res = await feed(fx.tripId, fx.adminToken);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].selfie ?? null).toBeNull();
  });

  it("selfies don't count in the user-visible totals", async () => {
    const fx = await fixture();
    const detail = await api("GET", `/trips/${fx.tripId}`, { token: fx.adminToken });
    expect(detail.body.totalUploaded).toBe(1);
    const mine = await api("GET", "/me/trips", { token: fx.adminToken });
    expect(mine.body.trips.find((t: any) => t.id === fx.tripId).totalUploaded).toBe(1);
  });
});

describe("selfie interactions", () => {
  async function revealed() {
    const fx = await fixture();
    const fede = await joinAs(fx.code, "Fede");
    await api("POST", `/trips/${fx.tripId}/reveal`, { token: fx.adminToken });
    return { ...fx, fede };
  }

  it("the selfie takes no likes, comments or featuring (400); the main photo still does", async () => {
    const fx = await revealed();
    const t = { token: fx.adminToken };
    expect((await api("PUT", `/media/${fx.selfieId}/like`, t)).status).toBe(400);
    expect((await api("DELETE", `/media/${fx.selfieId}/like`, t)).status).toBe(400);
    expect((await api("POST", `/media/${fx.selfieId}/comments`, { ...t, body: { text: "hola" } })).status).toBe(400);
    expect((await api("GET", `/media/${fx.selfieId}/comments`, t)).status).toBe(400);
    expect((await api("PUT", `/me/featured/${fx.selfieId}`, t)).status).toBe(400);
    expect((await api("DELETE", `/me/featured/${fx.selfieId}`, t)).status).toBe(400);
    expect((await api("PUT", `/media/${fx.mainId}/like`, t)).status).toBe(204);
  });

  it("neither image of a moment can be featured (400); an ordinary photo still can", async () => {
    const fx = await revealed();
    const t = { token: fx.adminToken };
    for (const id of [fx.mainId, fx.selfieId]) {
      const res = await api("PUT", `/me/featured/${id}`, t);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Las fotos del momento no se pueden agregar a tu perfil.");
    }
    const other = await newTrip({ startsAt: Date.now() - 5 * DAY });
    const ordinary = await uploadMedia(other.tripId, other.adminToken);
    await api("POST", `/trips/${other.tripId}/reveal`, { token: other.adminToken });
    expect((await api("PUT", `/me/featured/${ordinary}`, { token: other.adminToken })).status).toBe(204);
  });

  it("the revealed feed says a moment photo cannot be featured, and an ordinary one can", async () => {
    const fx = await fixture();
    const ordinary = await uploadMedia(fx.tripId, fx.adminToken);
    await api("POST", `/trips/${fx.tripId}/reveal`, { token: fx.adminToken });
    const items = (await feed(fx.tripId, fx.adminToken)).body.items;
    expect(items.find((i: any) => i.id === fx.mainId).canFeature).toBe(false);
    expect(items.find((i: any) => i.id === ordinary).canFeature).toBe(true);
  });

  it("a report on the selfie is accepted and hides only the selfie from the reporter", async () => {
    const fx = await revealed();
    const fede = fx.fede;
    const res = await api("POST", "/reports", { token: fede.token, body: { mediaId: fx.selfieId, reason: "offensive" } });
    expect(res.status).toBe(204);
    const mine = (await feed(fx.tripId, fede.token)).body.items;
    expect(mine.map((i: any) => i.id)).toEqual([fx.mainId]);
    expect(mine[0].selfie ?? null).toBeNull();
    const others = (await feed(fx.tripId, fx.adminToken)).body.items;
    expect(others[0].selfie.id).toBe(fx.selfieId);
  });
});
