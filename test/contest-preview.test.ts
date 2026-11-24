import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { HOUR, addMediaDirect, api, createTrip, grantEvents, putFiles, signUp } from "./helpers";

/** Event with groups A and B, ended 1 h ago, reveal in 3 h. A guest in A and a photo of each of two guests (A and B). */
async function endedEvent(opts: { contest?: boolean; endsAt?: number } = {}) {
  const org = await signUp(undefined, "Org");
  await grantEvents(org.userId);
  const now = Date.now();
  const { tripId, code } = await createTrip(org.token, {
    type: "event",
    groups: ["A", "B"],
    photoLimitMode: "total",
    totalPhotoLimit: 20,
    dailyPhotoLimit: undefined,
    dailyVideoLimit: undefined,
    startsAt: now - 5 * HOUR,
    endsAt: opts.endsAt ?? now - HOUR,
    revealAt: now + 3 * HOUR,
  });
  await env.DB.prepare("UPDATE trips SET contest_enabled = ? WHERE id = ?")
    .bind(opts.contest === false ? 0 : 1, tripId)
    .run();
  const detail = await api("GET", `/trips/${tripId}`, { token: org.token });
  const [a, b] = (detail.body.trip.groups as { id: string }[]).map((g) => g.id) as [string, string];
  const guest = async (name: string, groupId: string) => {
    const user = await signUp(undefined, name);
    const res = await api("POST", "/trips/join", { token: user.token, body: { code, groupIds: [groupId] } });
    if (res.status !== 201) throw new Error(`join failed: ${res.status}`);
    return { token: user.token, userId: user.userId, memberId: res.body.member.id as string };
  };
  const ga = await guest("Ga", a);
  const gb = await guest("Gb", b);
  const photo = async (author: typeof ga, groupId: string) => {
    const [id] = await addMediaDirect(tripId, [author], 1, { from: now - 3 * HOUR, to: now - 2 * HOUR });
    await env.DB.prepare("INSERT INTO media_groups (media_id, group_id) VALUES (?, ?)").bind(id, groupId).run();
    await putFiles(tripId, id!);
    return id!;
  };
  const photoA = await photo(ga, a);
  const photoB = await photo(gb, b);
  return { org, tripId, ga, gb, photoA, photoB };
}

const feed = (tripId: string, token: string) => api("GET", `/trips/${tripId}/feed`, { token });

describe("organizer preview before the reveal", () => {
  it("organizer sees files after ends_at with the contest on", async () => {
    const fx = await endedEvent();
    const res = await feed(fx.tripId, fx.org.token);
    expect(res.body.revealed).toBe(false);
    expect(res.body.items).toHaveLength(2);
    for (const item of res.body.items) {
      expect(item.files.thumb).toContain(`/trips/${fx.tripId}/media/${item.id}/thumb`);
      expect(item.width).toBe(4032);
      expect(item.originalAvailable).toBe(true);
      expect(item.likeCount).toBeUndefined();
      expect(item.likedByMe).toBeUndefined();
      expect(item.featuredByMe).toBeUndefined();
      expect(item.canFeature).toBeUndefined();
    }
  });

  it("organizer sees nothing before ends_at", async () => {
    const fx = await endedEvent({ endsAt: Date.now() + HOUR });
    const res = await feed(fx.tripId, fx.org.token);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) expect(item.files).toBeUndefined();
    expect((await api("GET", `/trips/${fx.tripId}/media/${fx.photoA}/display`, { token: fx.org.token })).status).toBe(403);
  });

  it("organizer sees nothing with the contest off", async () => {
    const fx = await endedEvent({ contest: false });
    const res = await feed(fx.tripId, fx.org.token);
    for (const item of res.body.items) expect(item.files).toBeUndefined();
    expect((await api("GET", `/trips/${fx.tripId}/media/${fx.photoA}/thumb`, { token: fx.org.token })).status).toBe(403);
  });

  it("guest sees nothing between ends_at and reveal", async () => {
    const fx = await endedEvent();
    const res = await feed(fx.tripId, fx.ga.token);
    for (const item of res.body.items) expect(item.files).toBeUndefined();
    const dl = await api("GET", `/trips/${fx.tripId}/media/${fx.photoA}/thumb`, { token: fx.ga.token });
    expect(dl.status).toBe(403);
  });

  it("organizer can download display of a photo from any group in that window", async () => {
    const fx = await endedEvent();
    for (const id of [fx.photoA, fx.photoB]) {
      for (const variant of ["thumb", "display", "original"]) {
        expect((await api("GET", `/trips/${fx.tripId}/media/${id}/${variant}`, { token: fx.org.token })).status).toBe(200);
      }
    }
  });
});
