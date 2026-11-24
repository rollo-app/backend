import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { flushPendingPushes } from "../src/lib/push";
import { castVote, runContestNotices } from "../src/modules/contest/contest.service";
import type { TripRow } from "../src/types";
import { HOUR, addMediaDirect, api, createTrip, grantEvents, mockExpo, putFiles, registerToken, signUp } from "./helpers";

type Stage = "before-end" | "selecting" | "voting" | "over";

/**
 * Contest event "Casamiento" (organizer Org, groups A and B) with Ga (A), Gb and Gc (B) and four photos (Ga, Gb, Ga, Gb).
 * The first `finalists` photos are finalists. Every user has a push token named after them. Voting window: 24 h.
 */
async function fixture(opts: { stage: Stage; finalists?: number; reveal?: "manual" | "auto" }) {
  const org = await signUp(undefined, "Org");
  await grantEvents(org.userId);
  const now = Date.now();
  const { tripId, code } = await createTrip(org.token, {
    type: "event",
    name: "Casamiento",
    groups: ["A", "B"],
    photoLimitMode: "total",
    totalPhotoLimit: 50,
    dailyPhotoLimit: undefined,
    dailyVideoLimit: undefined,
    startsAt: now - 5 * HOUR,
    endsAt: now - HOUR,
    revealAt: now + 3 * HOUR,
  });
  await setTrip(tripId, "contest_enabled = 1, contest_voting_hours = 24");
  const detail = await api("GET", `/trips/${tripId}`, { token: org.token });
  const [a, b] = (detail.body.trip.groups as { id: string }[]).map((g) => g.id) as [string, string];
  const guest = async (name: string, groupId: string) => {
    const user = await signUp(undefined, name);
    const res = await api("POST", "/trips/join", { token: user.token, body: { code, groupIds: [groupId] } });
    await registerToken(user.token, name);
    return { token: user.token, userId: user.userId, memberId: res.body.member.id as string };
  };
  await registerToken(org.token, "Org");
  const ga = await guest("Ga", a);
  const gb = await guest("Gb", b);
  const gc = await guest("Gc", b);
  const ids = await addMediaDirect(tripId, [ga, gb], 4, { from: now - 3 * HOUR, to: now - 2 * HOUR, display: true });
  for (const id of ids) await putFiles(tripId, id, "photo", { display: true });
  for (const id of ids.slice(0, opts.finalists ?? 0)) {
    const res = await api("PUT", `/trips/${tripId}/contest/finalists/${id}`, { token: org.token });
    if (res.status !== 204) throw new Error(`finalist failed: ${res.status}`);
  }
  if (opts.stage === "before-end") await setTrip(tripId, "ends_at = ?, reveal_at = ?", now + HOUR, now + 4 * HOUR);
  const revealedAt = opts.stage === "voting" ? now - HOUR : opts.stage === "over" ? now - 25 * HOUR : null;
  if (revealedAt !== null) {
    if (opts.reveal === "auto") await setTrip(tripId, "reveal_at = ?, revealed_at = NULL", revealedAt);
    else await setTrip(tripId, "revealed_at = ?", revealedAt);
    await setTrip(tripId, "revealed_notified_at = ?", revealedAt);
  }
  return { org, tripId, ga, gb, gc, ids, now };
}

const setTrip = (tripId: string, set: string, ...binds: unknown[]) =>
  env.DB.prepare(`UPDATE trips SET ${set} WHERE id = ?`).bind(...binds, tripId).run();
const tripRow = async (tripId: string) => (await env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(tripId).first<TripRow>())!;
const addVote = (tripId: string, userId: string, mediaId: string) =>
  env.DB.prepare("INSERT INTO contest_votes (trip_id, user_id, media_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind(tripId, userId, mediaId).run();
const get = (f: { tripId: string }, token: string) => api("GET", `/trips/${f.tripId}/contest`, { token });
const pickWinner = (f: { tripId: string }, token: string, mediaId: string) =>
  api("POST", `/trips/${f.tripId}/contest/winner`, { token, body: { mediaId } });

/** Who got which push: one line per message, "name: body → url". */
function received(expo: ReturnType<typeof mockExpo>) {
  return expo.sent.map((m) => `${m.to.replace(/^ExponentPushToken\[(.*)\]$/, "$1")}: ${m.body} → ${m.data.url}`).sort();
}

async function runCron(scheduledTime = Date.now()) {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime, cron: "*/5 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

const REVEAL_ERROR = "Elegí al menos 2 fotos para el concurso o apagalo.";

describe("manual reveal with a contest", () => {
  it("409 with fewer than 2 finalists", async () => {
    const f = await fixture({ stage: "selecting", finalists: 1 });
    const res = await api("POST", `/trips/${f.tripId}/reveal`, { token: f.org.token });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(REVEAL_ERROR);
    expect((await tripRow(f.tripId)).revealed_at).toBeNull();
  });

  it("409 before the end of the event", async () => {
    const f = await fixture({ stage: "before-end" });
    const res = await api("POST", `/trips/${f.tripId}/reveal`, { token: f.org.token });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(REVEAL_ERROR);
  });

  it("does not count a finalist that no longer counts (deleted)", async () => {
    const f = await fixture({ stage: "selecting", finalists: 2 });
    await env.DB.prepare("UPDATE media SET deleted_at = 1 WHERE id = ?").bind(f.ids[1]).run();
    expect((await api("POST", `/trips/${f.tripId}/reveal`, { token: f.org.token })).status).toBe(409);
  });

  it("reveals with 2 finalists and the push invites to vote", async () => {
    const f = await fixture({ stage: "selecting", finalists: 2 });
    const expo = mockExpo();
    expect((await api("POST", `/trips/${f.tripId}/reveal`, { token: f.org.token })).status).toBe(200);
    await flushPendingPushes();
    expect(received(expo)).toEqual(
      ["Ga", "Gb", "Gc"].map((n) => `${n}: Se reveló Casamiento. ¡Ya podés votar la mejor foto! → /reveal?trip=${f.tripId}`),
    );
    expect((await get(f, f.gb.token)).body.status).toBe("voting");
  });

  it("an event without contest reveals as always", async () => {
    const f = await fixture({ stage: "selecting" });
    await setTrip(f.tripId, "contest_enabled = 0");
    const expo = mockExpo();
    expect((await api("POST", `/trips/${f.tripId}/reveal`, { token: f.org.token })).status).toBe(200);
    await flushPendingPushes();
    expect(received(expo)).toContain(`Ga: Se reveló Casamiento → /reveal?trip=${f.tripId}`);
  });
});

describe("contest cron: before the reveal", () => {
  it("tells the organizers once that they can pick the finalists", async () => {
    const f = await fixture({ stage: "selecting" });
    const expo = mockExpo();
    await runContestNotices(env, f.now);
    await runContestNotices(env, f.now + 5 * 60_000);
    expect(received(expo)).toEqual([`Org: Ya podés elegir las finalistas → /contest-picks?trip=${f.tripId}`]);
  });

  it("does not tell them before the end", async () => {
    const f = await fixture({ stage: "before-end" });
    const expo = mockExpo();
    await runContestNotices(env, f.now);
    expect(expo.sent).toEqual([]);
  });

  it("reminds the organizers once, 2 hours before the reveal, if there are fewer than 2 finalists", async () => {
    const f = await fixture({ stage: "selecting", finalists: 1 });
    await setTrip(f.tripId, "contest_select_notified_at = 1");
    const expo = mockExpo();
    await runContestNotices(env, f.now); // reveal in 3 h: too early
    expect(expo.sent).toEqual([]);
    await runContestNotices(env, f.now + 1.5 * HOUR);
    await runContestNotices(env, f.now + 2 * HOUR);
    expect(received(expo)).toEqual([`Org: Elegí las finalistas del concurso antes del revelado → /contest-picks?trip=${f.tripId}`]);
  });

  it("no reminder with 2 finalists", async () => {
    const f = await fixture({ stage: "selecting", finalists: 2 });
    await setTrip(f.tripId, "contest_select_notified_at = 1");
    const expo = mockExpo();
    await runContestNotices(env, f.now + 1.5 * HOUR);
    expect(expo.sent).toEqual([]);
  });
});

describe("contest cron: automatic reveal", () => {
  it("with fewer than 2 finalists the contest is cancelled and the organizers are told", async () => {
    const f = await fixture({ stage: "selecting", finalists: 1 });
    await setTrip(f.tripId, "reveal_at = ?, contest_select_notified_at = 1", f.now - 60_000);
    const expo = mockExpo();
    await runCron(f.now);
    expect(received(expo)).toEqual([
      `Ga: Se reveló Casamiento → /reveal?trip=${f.tripId}`,
      `Gb: Se reveló Casamiento → /reveal?trip=${f.tripId}`,
      `Gc: Se reveló Casamiento → /reveal?trip=${f.tripId}`,
      `Org: El concurso se canceló: no había finalistas. → /contest?trip=${f.tripId}`,
      `Org: Se reveló Casamiento → /reveal?trip=${f.tripId}`,
    ]);
    expect((await get(f, f.gb.token)).body.status).toBe("cancelled");
    await runCron(f.now + 5 * 60_000);
    expect(expo.sent).toHaveLength(5);
  });

  it("with 2 finalists the reveal push invites to vote and voting opens", async () => {
    const f = await fixture({ stage: "selecting", finalists: 2 });
    await setTrip(f.tripId, "reveal_at = ?, contest_select_notified_at = 1", f.now - 60_000);
    const expo = mockExpo();
    await runCron(f.now);
    expect(received(expo)).toContain(`Gb: Se reveló Casamiento. ¡Ya podés votar la mejor foto! → /reveal?trip=${f.tripId}`);
    expect(expo.sent).toHaveLength(4);
    expect((await get(f, f.gb.token)).body.status).toBe("voting");
  });

  it("a finalist lost during the voting does not cancel it", async () => {
    const f = await fixture({ stage: "voting", finalists: 2, reveal: "auto" });
    await env.DB.prepare("UPDATE media SET deleted_at = 1 WHERE id = ?").bind(f.ids[1]).run();
    const expo = mockExpo();
    await runContestNotices(env, f.now);
    expect(expo.sent).toEqual([]);
    expect((await get(f, f.gb.token)).body.status).toBe("voting");
  });
});

describe("contest cron: close", () => {
  it("a single leader wins: closed, winner and votes, the author gets their own push", async () => {
    const f = await fixture({ stage: "over", finalists: 3 });
    await addVote(f.tripId, f.gb.userId, f.ids[0]!);
    await addVote(f.tripId, f.gc.userId, f.ids[0]!);
    await addVote(f.tripId, f.ga.userId, f.ids[1]!);
    const expo = mockExpo();
    await runContestNotices(env, f.now);
    expect(received(expo)).toEqual([
      `Ga: ¡Tu foto ganó el concurso de Casamiento! → /contest?trip=${f.tripId}`,
      `Gb: Ganó la foto de Ga 🏆 → /contest?trip=${f.tripId}`,
      `Gc: Ganó la foto de Ga 🏆 → /contest?trip=${f.tripId}`,
      `Org: Ganó la foto de Ga 🏆 → /contest?trip=${f.tripId}`,
    ]);
    const row = await tripRow(f.tripId);
    expect(row.contest_closed_at).toBe(f.now);
    expect(row.contest_winner_media_id).toBe(f.ids[0]);
    const res = await get(f, f.gc.token);
    expect(res.body.status).toBe("closed");
    expect(res.body.winner).toMatchObject({ mediaId: f.ids[0], author: { userId: f.ga.userId, name: "Ga" }, imageAvailable: true });
    expect(res.body.finalists.map((x: { votes: number }) => x.votes)).toEqual([2, 1, 0]);
    await runContestNotices(env, f.now + 5 * 60_000);
    expect(expo.sent).toHaveLength(4);
  });

  it("two runs at once announce once", async () => {
    const f = await fixture({ stage: "over", finalists: 2 });
    await addVote(f.tripId, f.gc.userId, f.ids[1]!);
    const expo = mockExpo();
    await Promise.all([runContestNotices(env, f.now), runContestNotices(env, f.now)]);
    expect(expo.sent).toHaveLength(4);
    expect((await tripRow(f.tripId)).contest_winner_media_id).toBe(f.ids[1]);
  });

  it("the cron closes an automatically revealed contest too", async () => {
    const f = await fixture({ stage: "over", finalists: 2, reveal: "auto" });
    await addVote(f.tripId, f.gc.userId, f.ids[1]!);
    mockExpo();
    await runContestNotices(env, f.now);
    expect((await tripRow(f.tripId)).contest_winner_media_id).toBe(f.ids[1]);
  });

  it("with a single finalist left, that one wins", async () => {
    const f = await fixture({ stage: "over", finalists: 2 });
    await env.DB.prepare("UPDATE media SET archived_at = 1 WHERE id = ?").bind(f.ids[0]).run();
    mockExpo();
    await runContestNotices(env, f.now);
    expect((await tripRow(f.tripId)).contest_winner_media_id).toBe(f.ids[1]);
  });

  it("with no finalist left the contest is cancelled and the organizers are told", async () => {
    const f = await fixture({ stage: "over", finalists: 2 });
    await env.DB.prepare("UPDATE media SET deleted_at = 1 WHERE trip_id = ?").bind(f.tripId).run();
    const expo = mockExpo();
    await runContestNotices(env, f.now);
    expect(received(expo)).toEqual([`Org: El concurso se canceló: no había finalistas. → /contest?trip=${f.tripId}`]);
    expect((await get(f, f.org.token)).body.status).toBe("cancelled");
  });

  it("a 0-0 tie is tied, tells the organizers, and repeats only after 24 hours", async () => {
    const f = await fixture({ stage: "over", finalists: 2 });
    const expo = mockExpo();
    await runContestNotices(env, f.now);
    const line = `Org: Hay un empate en el concurso: elegí la ganadora → /contest?trip=${f.tripId}`;
    expect(received(expo)).toEqual([line]);
    const res = await get(f, f.org.token);
    expect(res.body.status).toBe("tied");
    expect(res.body.tiedMediaIds).toEqual([f.ids[0], f.ids[1]]);
    expect((await tripRow(f.tripId)).contest_closed_at).toBeNull();
    await runContestNotices(env, f.now + 23 * HOUR);
    expect(expo.sent).toHaveLength(1);
    await runContestNotices(env, f.now + 24 * HOUR);
    expect(received(expo)).toEqual([line, line]);
  });

  it("respects the contestResult preference", async () => {
    const f = await fixture({ stage: "over", finalists: 2 });
    await addVote(f.tripId, f.gc.userId, f.ids[0]!);
    const off = await api("PATCH", "/me/settings", { token: f.gb.token, body: { notifications: { contestResult: false } } });
    expect(off.status).toBe(200);
    expect(off.body.notifications.contestResult).toBe(false);
    const expo = mockExpo();
    await runContestNotices(env, f.now);
    expect(received(expo).some((l) => l.startsWith("Gb:"))).toBe(false);
    expect(expo.sent).toHaveLength(3);
  });
});

describe("POST /trips/{tripId}/contest/winner", () => {
  it("an organizer breaks the tie: closes and announces", async () => {
    const f = await fixture({ stage: "over", finalists: 3 });
    await addVote(f.tripId, f.gc.userId, f.ids[0]!);
    await addVote(f.tripId, f.ga.userId, f.ids[1]!);
    const expo = mockExpo();
    const res = await pickWinner(f, f.org.token, f.ids[1]!);
    expect(res.status).toBe(204);
    await flushPendingPushes();
    expect(received(expo)).toEqual([
      `Ga: Ganó la foto de Gb 🏆 → /contest?trip=${f.tripId}`,
      `Gb: ¡Tu foto ganó el concurso de Casamiento! → /contest?trip=${f.tripId}`,
      `Gc: Ganó la foto de Gb 🏆 → /contest?trip=${f.tripId}`,
      `Org: Ganó la foto de Gb 🏆 → /contest?trip=${f.tripId}`,
    ]);
    const contest = await get(f, f.ga.token);
    expect(contest.body.status).toBe("closed");
    expect(contest.body.winner.mediaId).toBe(f.ids[1]);
    // Closed: picking again is a conflict and the cron does not announce again.
    expect((await pickWinner(f, f.org.token, f.ids[0]!)).status).toBe(409);
    await runContestNotices(env, f.now);
    expect(expo.sent).toHaveLength(4);
  });

  it("400 for a finalist that is not among the tied ones", async () => {
    const f = await fixture({ stage: "over", finalists: 3 });
    await addVote(f.tripId, f.gc.userId, f.ids[0]!);
    await addVote(f.tripId, f.ga.userId, f.ids[1]!);
    expect((await pickWinner(f, f.org.token, f.ids[2]!)).status).toBe(400);
  });

  it("409 when the contest is not tied", async () => {
    const f = await fixture({ stage: "voting", finalists: 2 });
    expect((await pickWinner(f, f.org.token, f.ids[0]!)).status).toBe(409);
  });

  it("403 for a guest", async () => {
    const f = await fixture({ stage: "over", finalists: 2 });
    expect((await pickWinner(f, f.gc.token, f.ids[0]!)).status).toBe(403);
  });
});

describe("after the close", () => {
  it("a deleted winner keeps the author without the image", async () => {
    const f = await fixture({ stage: "over", finalists: 2 });
    await addVote(f.tripId, f.gc.userId, f.ids[0]!);
    mockExpo();
    await runContestNotices(env, f.now);
    await env.DB.prepare("UPDATE media SET deleted_at = 1 WHERE id = ?").bind(f.ids[0]).run();
    const res = await get(f, f.gc.token);
    expect(res.body.status).toBe("closed");
    expect(res.body.winner).toMatchObject({ mediaId: f.ids[0], author: { name: "Ga" }, imageAvailable: false });
  });

  it("a vote that loses the race with the close is rejected", async () => {
    const f = await fixture({ stage: "voting", finalists: 2 });
    const stale = await tripRow(f.tripId);
    await setTrip(f.tripId, "contest_closed_at = ?, contest_winner_media_id = ?", f.now, f.ids[0]);
    await expect(castVote(env.DB, stale, f.gc.userId, f.ids[0]!, f.now)).rejects.toMatchObject({ message: "La votación no está abierta." });
    const votes = await env.DB.prepare("SELECT COUNT(*) AS n FROM contest_votes WHERE trip_id = ?").bind(f.tripId).first<{ n: number }>();
    expect(votes!.n).toBe(0);
  });
});
