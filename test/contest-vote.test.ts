import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { HOUR, addMediaDirect, api, createTrip, grantEvents, putFiles, signUp, thumbContent, displayContent, originalContent } from "./helpers";

/** Contest event, groups A and B, reveal in the past (voting open), `ga` (A) with 2 photos, `gb` (B) and `gc` (B) as voters. */
async function fixture(opts: { reveal?: "manual" | "auto" } = {}) {
  const org = await signUp(undefined, "Org");
  await grantEvents(org.userId);
  const now = Date.now();
  const { tripId, code } = await createTrip(org.token, {
    type: "event",
    groups: ["A", "B"],
    photoLimitMode: "total",
    totalPhotoLimit: 50,
    dailyPhotoLimit: undefined,
    dailyVideoLimit: undefined,
    startsAt: now - 5 * HOUR,
    endsAt: now - HOUR,
    revealAt: now + 3 * HOUR,
  });
  await env.DB.prepare("UPDATE trips SET contest_enabled = 1 WHERE id = ?").bind(tripId).run();
  const detail = await api("GET", `/trips/${tripId}`, { token: org.token });
  const [a, b] = (detail.body.trip.groups as { id: string }[]).map((g) => g.id) as [string, string];
  const guest = async (name: string, groupId: string) => {
    const user = await signUp(undefined, name);
    const res = await api("POST", "/trips/join", { token: user.token, body: { code, groupIds: [groupId] } });
    return { token: user.token, userId: user.userId, memberId: res.body.member.id as string };
  };
  const ga = await guest("Ga", a);
  const gb = await guest("Gb", b);
  const gc = await guest("Gc", b);
  const ids = await addMediaDirect(tripId, [ga, gb], 4, { from: now - 3 * HOUR, to: now - 2 * HOUR, display: true }); // ga, gb, ga, gb
  for (const id of ids) await putFiles(tripId, id, "photo", { display: true });
  for (const id of ids.slice(0, 3)) await api("PUT", `/trips/${tripId}/contest/finalists/${id}`, { token: org.token });
  if (opts.reveal === "auto") {
    await env.DB.prepare("UPDATE trips SET reveal_at = ?, revealed_at = NULL WHERE id = ?").bind(now - HOUR, tripId).run();
  } else {
    await env.DB.prepare("UPDATE trips SET revealed_at = ? WHERE id = ?").bind(now - HOUR, tripId).run();
  }
  return { org, tripId, ga, gb, gc, ids };
}

const vote = (f: { tripId: string }, token: string, mediaId: string) =>
  api("PUT", `/trips/${f.tripId}/contest/vote`, { token, body: { mediaId } });
const unvote = (f: { tripId: string }, token: string) => api("DELETE", `/trips/${f.tripId}/contest/vote`, { token });
const get = (f: { tripId: string }, token: string) => api("GET", `/trips/${f.tripId}/contest`, { token });
const file = (f: { tripId: string }, token: string, id: string, variant = "display") =>
  api("GET", `/trips/${f.tripId}/contest/finalists/${id}/${variant}`, { token });
const setTrip = (tripId: string, set: string, ...binds: unknown[]) =>
  env.DB.prepare(`UPDATE trips SET ${set} WHERE id = ?`).bind(...binds, tripId).run();
const votesOf = async (tripId: string) =>
  (await env.DB.prepare("SELECT user_id, media_id FROM contest_votes WHERE trip_id = ?").bind(tripId).all()).results;

describe("contest vote", () => {
  it("votes, changes the vote (one row) and removes it", async () => {
    const f = await fixture();
    expect((await vote(f, f.gb.token, f.ids[0]!)).status).toBe(204);
    expect((await get(f, f.gb.token)).body.myVote).toBe(f.ids[0]);
    expect((await vote(f, f.gb.token, f.ids[2]!)).status).toBe(204);
    expect((await get(f, f.gb.token)).body.myVote).toBe(f.ids[2]);
    expect(await votesOf(f.tripId)).toHaveLength(1);
    expect((await unvote(f, f.gb.token)).status).toBe(204);
    expect((await unvote(f, f.gb.token)).status).toBe(204);
    expect((await get(f, f.gb.token)).body.myVote).toBeNull();
    expect(await votesOf(f.tripId)).toHaveLength(0);
  });

  it("400 on your own photo", async () => {
    const f = await fixture();
    const res = await vote(f, f.ga.token, f.ids[0]!);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("No podés votar tu propia foto.");
  });

  it("404 for a photo that is not a finalist", async () => {
    const f = await fixture();
    expect((await vote(f, f.gc.token, f.ids[3]!)).status).toBe(404);
  });

  it("409 before the reveal and after closesAt", async () => {
    const f = await fixture();
    await setTrip(f.tripId, "revealed_at = NULL, reveal_at = ?", Date.now() + HOUR);
    const early = await vote(f, f.gb.token, f.ids[0]!);
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("La votación no está abierta.");
    await setTrip(f.tripId, "revealed_at = ?", Date.now() - 100 * HOUR);
    expect((await vote(f, f.gb.token, f.ids[0]!)).status).toBe(409);
    await setTrip(f.tripId, "revealed_at = ?, contest_closed_at = ?, contest_winner_media_id = ?", Date.now() - 100 * HOUR, Date.now(), f.ids[0]);
    expect((await vote(f, f.gb.token, f.ids[0]!)).status).toBe(409);
  });

  it("DELETE outside the voting window changes nothing", async () => {
    const f = await fixture();
    await vote(f, f.gb.token, f.ids[0]!);
    await setTrip(f.tripId, "revealed_at = ?", Date.now() - 100 * HOUR);
    expect((await unvote(f, f.gb.token)).status).toBe(204);
    expect(await votesOf(f.tripId)).toHaveLength(1);
  });

  it("automatic reveal (reveal_at passed, revealed_at null) opens the voting", async () => {
    const f = await fixture({ reveal: "auto" });
    expect((await get(f, f.gb.token)).body.status).toBe("voting");
    expect((await vote(f, f.gb.token, f.ids[0]!)).status).toBe(204);
  });

  it("404 when voting for a finalist blocked with the author, and reported", async () => {
    const f = await fixture();
    await env.DB.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, 1)").bind(f.gb.userId, f.ga.userId).run();
    expect((await vote(f, f.gb.token, f.ids[0]!)).status).toBe(404);
    expect((await file(f, f.gb.token, f.ids[0]!)).status).toBe(404);
    expect((await vote(f, f.gc.token, f.ids[0]!)).status).toBe(204);
    await env.DB.prepare("INSERT INTO reports (id, reporter_id, media_id, target_user_id, trip_id, reason, created_at) VALUES ('r1', ?, ?, ?, ?, 'x', 1)")
      .bind(f.gc.userId, f.ids[0], f.ga.userId, f.tripId)
      .run();
    expect((await vote(f, f.gc.token, f.ids[0]!)).status).toBe(404);
    expect((await file(f, f.gc.token, f.ids[0]!)).status).toBe(404);
  });

  it("requires the event to have a contest", async () => {
    const f = await fixture();
    await setTrip(f.tripId, "contest_enabled = 0");
    expect((await vote(f, f.gb.token, f.ids[0]!)).status).toBe(404);
  });
});

describe("contest finalist files", () => {
  it("a guest from another group gets the display of a finalist, while the normal route still refuses", async () => {
    const f = await fixture();
    const res = await file(f, f.gb.token, f.ids[0]!);
    expect(res.status).toBe(200);
    expect(res.body).toBe(displayContent(f.ids[0]!));
    const normal = await api("GET", `/trips/${f.tripId}/media/${f.ids[0]}/display`, { token: f.gb.token });
    expect(normal.status).not.toBe(200);
  });

  it("serves thumb and display content, display falls back to the original", async () => {
    const f = await fixture();
    const raw = async (id: string, variant: string) => {
      const r = await file(f, f.gb.token, id, variant);
      return { status: r.status, text: r.body };
    };
    expect(await raw(f.ids[0]!, "thumb")).toEqual({ status: 200, text: thumbContent(f.ids[0]!) });
    expect(await raw(f.ids[0]!, "display")).toEqual({ status: 200, text: displayContent(f.ids[0]!) });
    await env.DB.prepare("UPDATE media SET display_key = NULL WHERE id = ?").bind(f.ids[0]).run();
    expect(await raw(f.ids[0]!, "display")).toEqual({ status: 200, text: originalContent(f.ids[0]!) });
  });

  it("404 for a photo that is not a finalist, and for the original variant", async () => {
    const f = await fixture();
    expect((await file(f, f.gb.token, f.ids[3]!)).status).toBe(404);
    expect((await file(f, f.gb.token, f.ids[0]!, "original")).status).toBe(400);
  });

  it("not while pending or for guests while selecting; organizers do see them while selecting", async () => {
    const f = await fixture();
    await setTrip(f.tripId, "revealed_at = NULL, reveal_at = ?", Date.now() + HOUR);
    expect((await file(f, f.gb.token, f.ids[0]!)).status).toBe(404);
    expect((await file(f, f.org.token, f.ids[0]!)).status).toBe(200);
    await setTrip(f.tripId, "ends_at = ?", Date.now() + HOUR);
    expect((await file(f, f.org.token, f.ids[0]!)).status).toBe(404);
  });

  it("served in closing, tied and closed", async () => {
    const f = await fixture();
    await setTrip(f.tripId, "revealed_at = ?", Date.now() - 100 * HOUR); // closing / tied
    expect((await file(f, f.gb.token, f.ids[0]!)).status).toBe(200);
    await setTrip(f.tripId, "contest_closed_at = ?, contest_winner_media_id = ?", Date.now(), f.ids[0]);
    expect((await file(f, f.gb.token, f.ids[0]!)).status).toBe(200);
  });

  it("404 for non-members and when the contest is cancelled", async () => {
    const f = await fixture();
    const stranger = await signUp(undefined, "Str");
    expect((await file(f, stranger.token, f.ids[0]!)).status).toBe(403);
    await setTrip(f.tripId, "contest_cancelled_at = ?", Date.now());
    expect((await file(f, f.gb.token, f.ids[0]!)).status).toBe(404);
  });

  it("the winner's file follows the viewer-hidden rule and imageAvailable matches", async () => {
    const f = await fixture();
    await setTrip(f.tripId, "revealed_at = ?, contest_closed_at = ?, contest_winner_media_id = ?", Date.now() - 100 * HOUR, Date.now(), f.ids[0]);
    let res = await get(f, f.gb.token);
    expect(res.body.winner.imageAvailable).toBe(true);
    await env.DB.prepare("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, 1)").bind(f.ga.userId, f.gb.userId).run();
    res = await get(f, f.gb.token);
    expect(res.body.winner.imageAvailable).toBe(false);
    expect((await file(f, f.gb.token, f.ids[0]!)).status).toBe(404);
    res = await get(f, f.gc.token);
    expect(res.body.winner.imageAvailable).toBe(true);
    await env.DB.prepare("UPDATE media SET deleted_at = 1 WHERE id = ?").bind(f.ids[0]).run();
    expect((await get(f, f.gc.token)).body.winner.imageAvailable).toBe(false);
  });
});
