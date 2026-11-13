import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { sweepOrphanCovers } from "../src/lib/cover-sweep";
import { createTrip, signUp } from "./helpers";

const HOUR = 60 * 60 * 1000;
const key = (tripId: string) => `trips/${tripId}/cover/${crypto.randomUUID()}.jpg`;
const exists = async (k: string) => (await env.MEDIA.head(k)) !== null;
const put = (k: string) => env.MEDIA.put(k, new Uint8Array([0xff, 0xd8, 0xff]));

async function newEvent() {
  const org = await signUp(undefined, "Org");
  const { tripId } = await createTrip(org.token, {
    type: "event",
    groups: ["A"],
    photoLimitMode: "total",
    totalPhotoLimit: 20,
    dailyPhotoLimit: undefined,
    dailyVideoLimit: undefined,
  });
  return tripId;
}

// The local R2 stamps `uploaded` with the real clock, so the tests move `now` forward instead.
describe("sweepOrphanCovers", () => {
  it("deletes unreferenced covers older than 1 hour, keeping the cover and the pending one", async () => {
    const tripId = await newEvent();
    const [cover, pending, orphan] = [key(tripId), key(tripId), key(tripId)];
    for (const k of [cover, pending, orphan]) await put(k);
    await env.DB.prepare("UPDATE trips SET cover_key = ?, pending_cover_key = ? WHERE id = ?").bind(cover, pending, tripId).run();

    await sweepOrphanCovers(env, Date.now() + 2 * HOUR);
    expect(await exists(cover)).toBe(true);
    expect(await exists(pending)).toBe(true);
    expect(await exists(orphan)).toBe(false);
  });

  it("keeps a fresh unreferenced cover until it is older than 1 hour", async () => {
    const tripId = await newEvent();
    const fresh = key(tripId);
    await put(fresh);
    await sweepOrphanCovers(env, Date.now() + 30 * 60 * 1000);
    expect(await exists(fresh)).toBe(true);
    await sweepOrphanCovers(env, Date.now() + 2 * HOUR);
    expect(await exists(fresh)).toBe(false);
  });

  it("never touches other files of the trip", async () => {
    const tripId = await newEvent();
    const media = `trips/${tripId}/media-1/original`;
    await put(media);
    await sweepOrphanCovers(env, Date.now() + 2 * HOUR);
    expect(await exists(media)).toBe(true);
    await env.MEDIA.delete(media);
  });

  it("walks the event trips in slices and starts over after reaching the end", async () => {
    for (let i = 0; i < 3; i++) await newEvent();
    // Orphans in the first and in the last event trip (ordered by id), whatever else the file created.
    const [first, last] = [
      (await env.DB.prepare("SELECT MIN(id) AS id FROM trips WHERE type = 'event'").first<{ id: string }>())!.id,
      (await env.DB.prepare("SELECT MAX(id) AS id FROM trips WHERE type = 'event'").first<{ id: string }>())!.id,
    ];
    const [early, late] = [key(first), key(last)];
    for (const k of [early, late]) await put(k);
    const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM trips WHERE type = 'event'").first<{ n: number }>())!.n;
    const later = Date.now() + 2 * HOUR;
    const state = () => env.DB.prepare("SELECT value FROM cron_state WHERE key = 'cover_sweep_after'").first<{ value: string }>();

    await sweepOrphanCovers(env, later, { tripsPerRun: total - 1 });
    expect((await state())?.value).toBeDefined();
    expect(await exists(early)).toBe(false);
    expect(await exists(late)).toBe(true);

    await sweepOrphanCovers(env, later, { tripsPerRun: total - 1 });
    expect(await state()).toBeNull();
    expect(await exists(late)).toBe(false);
  });

  it("the cron runs it", async () => {
    const tripId = await newEvent();
    const orphan = key(tripId);
    await put(orphan);
    const ctx = createExecutionContext();
    await (app as any).scheduled(createScheduledController({ scheduledTime: new Date(Date.now() + 2 * HOUR) }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await exists(orphan)).toBe(false);
  });
});
