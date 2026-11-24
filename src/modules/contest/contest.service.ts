import { badRequest, conflict, notFound } from "../../shared/errors";
import type { AfterResponse } from "../../shared/after-response";
import { resolveVariantKey, type MediaVariant } from "../../lib/media-variant";
import { sendPush, type PushMessage } from "../../lib/push";
import { avatarUrl, isRevealed } from "../../lib/util";
import type { Env, MemberRow, TripRow } from "../../types";
import { CONTEST_REMINDER_LEAD_MS, contestStatus, closesAt, organizerPreviewOpen } from "./contest.rules";
import * as repo from "./contest.repository";

const NOT_OPEN = "Las finalistas se eligen entre el fin del evento y el revelado.";
const NO_CONTEST = "Este evento no tiene concurso.";

function assertSelectionOpen(trip: TripRow, member: MemberRow, now: number) {
  if (!organizerPreviewOpen(trip, member, now)) throw conflict(NOT_OPEN);
}

/** Marks a photo as finalist (idempotent). 400 unless it is an uploaded photo of this event that is not a moment selfie. */
export async function addFinalist(db: D1Database, trip: TripRow, member: MemberRow, mediaId: string, now = Date.now()) {
  assertSelectionOpen(trip, member, now);
  const media = await repo.findMediaForFinalist(db, mediaId);
  if (!media || media.trip_id !== trip.id || media.type !== "photo" || media.status !== "uploaded" || media.deleted_at !== null || media.paired_media_id !== null) {
    throw badRequest("Esa foto no puede ser finalista.");
  }
  await repo.insertFinalist(db, trip.id, mediaId, now).run();
}

export async function removeFinalist(db: D1Database, trip: TripRow, member: MemberRow, mediaId: string, now = Date.now()) {
  assertSelectionOpen(trip, member, now);
  await repo.deleteFinalist(db, trip.id, mediaId).run();
}

export async function getContest(db: D1Database, trip: TripRow, member: MemberRow, viewerUserId: string, now = Date.now()) {
  if (trip.type !== "event" || trip.contest_enabled !== 1) throw notFound(NO_CONTEST);
  let status = contestStatus(trip, now);
  // Past the voting window: the tie is decided over the countable set, the same for every viewer.
  let tiedLeaders: string[] = [];
  if (status === "closing") {
    tiedLeaders = (await leaders(db, trip.id)).leaders;
    status = contestStatus(trip, now, tiedLeaders.length);
  }
  // Guests only see the finalists once the event is revealed; organizers see them while choosing.
  const visible = isRevealed(trip, now) || member.role === "admin";
  const finalists = visible && status !== "cancelled" ? await repo.validFinalists(db, trip.id, viewerUserId) : [];
  const ids = finalists.map((f) => f.mediaId);

  const counts = status === "closed" ? await repo.voteCounts(db, trip.id, ids) : new Map<string, number>();
  const tiedMediaIds = status === "tied" && member.role === "admin" ? tiedLeaders : [];

  const mine = await repo.getMyVote(db, trip.id, viewerUserId);
  const base = (id: string) => `/trips/${trip.id}/contest/finalists/${id}`;

  let winner = null;
  if (status === "closed" && trip.contest_winner_media_id) {
    const row = await repo.findWinner(db, trip.contest_winner_media_id);
    if (row) {
      winner = {
        mediaId: row.mediaId,
        author: { userId: row.authorUserId, name: row.authorName ?? "", username: row.authorUsername, avatarUrl: avatarUrl(row.authorUserId, row.authorAvatarKey) },
        // Not shown if it was deleted/archived, or hidden for this viewer (blocked either way, reported).
        imageAvailable: row.available === 1 && ids.includes(row.mediaId),
      };
    }
  }

  return {
    status,
    votingHours: trip.contest_voting_hours,
    closesAt: status === "cancelled" ? null : closesAt(trip),
    finalists: finalists.map((f) => ({
      mediaId: f.mediaId,
      author: { userId: f.authorUserId, name: f.authorName ?? "", username: f.authorUsername, avatarUrl: avatarUrl(f.authorUserId, f.authorAvatarKey) },
      thumbHash: f.thumbhash,
      width: f.width,
      height: f.height,
      thumbPath: `${base(f.mediaId)}/thumb`,
      displayPath: `${base(f.mediaId)}/display`,
      votes: status === "closed" ? (counts.get(f.mediaId) ?? 0) : null,
    })),
    myVote: mine && ids.includes(mine) ? mine : null,
    winner,
    tiedMediaIds,
  };
}

const VOTING_CLOSED = "La votación no está abierta.";

function contestOr404(trip: TripRow) {
  if (trip.type !== "event" || trip.contest_enabled !== 1) throw notFound(NO_CONTEST);
}

/** Casts or changes the vote: only while voting, for a finalist that counts for this viewer, never your own. */
export async function castVote(db: D1Database, trip: TripRow, userId: string, mediaId: string, now = Date.now()) {
  contestOr404(trip);
  if (contestStatus(trip, now) !== "voting") throw conflict(VOTING_CLOSED);
  const finalist = (await repo.validFinalists(db, trip.id, userId)).find((f) => f.mediaId === mediaId);
  if (!finalist) throw notFound("Esa foto no es finalista.");
  if (finalist.authorUserId === userId) throw badRequest("No podés votar tu propia foto.");
  // The upsert re-checks in SQL that the contest is still open: `trip` may be stale if the cron closed it meanwhile.
  const result = await repo.upsertVote(db, trip.id, userId, mediaId, now).run();
  if (result.meta.changes === 0) throw conflict(VOTING_CLOSED);
}

/** Removes the vote. Always succeeds, but outside the voting window it changes nothing (the tally is frozen). */
export async function removeVote(db: D1Database, trip: TripRow, userId: string, now = Date.now()) {
  if (trip.type !== "event" || trip.contest_enabled !== 1 || contestStatus(trip, now) !== "voting") return;
  await repo.deleteVote(db, trip.id, userId).run();
}

/**
 * R2 key of a finalist's file, served by the contest's own route (the normal media route stays group-scoped).
 * Active members, while voting, after it (closing, tied, closed); organizers also while choosing. 404 unless the photo is
 * a valid finalist for this viewer.
 */
export async function getFinalistFileKey(
  db: D1Database,
  trip: TripRow,
  member: MemberRow,
  viewerId: string,
  mediaId: string,
  variant: MediaVariant,
  now = Date.now(),
): Promise<{ key: string; fallbackKey: string | null }> {
  contestOr404(trip);
  const status = contestStatus(trip, now);
  const open = status === "voting" || status === "closing" || status === "tied" || status === "closed" || (status === "selecting" && member.role === "admin");
  if (!open) throw notFound();
  const valid = (await repo.validFinalists(db, trip.id, viewerId)).some((f) => f.mediaId === mediaId);
  const row = valid ? await repo.findFinalistKeys(db, trip.id, mediaId) : null;
  if (!row) throw notFound();
  return resolveVariantKey(row, variant);
}

// ---------- Close, tie and notices ----------

/** The countable finalists (viewer-independent) and the ones sharing the top vote count (0-0 included). */
async function leaders(db: D1Database, tripId: string): Promise<{ countable: string[]; leaders: string[] }> {
  const countable = await repo.countableFinalists(db, tripId);
  const tally = await repo.voteCounts(db, tripId, countable);
  const top = Math.max(0, ...countable.map((id) => tally.get(id) ?? 0));
  return { countable, leaders: countable.filter((id) => (tally.get(id) ?? 0) === top) };
}

type Trip = Pick<TripRow, "id" | "name">;

const contestUrl = (trip: Trip) => `/contest?trip=${trip.id}`;
const picksUrl = (trip: Trip) => `/contest-picks?trip=${trip.id}`;

/** Push to the event's organizers (active admins). The title names the event: an organizer may run more than one. */
async function notifyOrganizers(env: Pick<Env, "DB">, trip: Trip, body: string, url: string): Promise<void> {
  const message: PushMessage = { title: trip.name, body, url };
  await sendPush(env, await repo.activeMemberUserIds(env.DB, trip.id, true), "contestResult", message);
}

const cancelledNotice = (env: Pick<Env, "DB">, trip: Trip) =>
  notifyOrganizers(env, trip, "El concurso se canceló: no había finalistas.", contestUrl(trip));

/** "Ganó la foto de {autor} 🏆" to every active member but the author, who gets their own message instead. */
async function announceWinner(env: Pick<Env, "DB">, trip: Trip, mediaId: string): Promise<void> {
  const winner = await repo.findWinner(env.DB, mediaId);
  if (!winner) return;
  const members = await repo.activeMemberUserIds(env.DB, trip.id);
  const url = contestUrl(trip);
  // The author is the actor: nobody with a block with them gets a push naming them.
  const others = members.filter((id) => id !== winner.authorUserId);
  await sendPush(env, others, "contestResult", { body: `Ganó la foto de ${winner.authorName ?? ""} 🏆`, url }, { actorId: winner.authorUserId });
  if (members.includes(winner.authorUserId)) {
    await sendPush(env, [winner.authorUserId], "contestResult", { body: `¡Tu foto ganó el concurso de ${trip.name}!`, url });
  }
}

/**
 * Decides, once, whether the reveal opens the voting. Called right after the reveal is claimed (manual reveal or the
 * cron's "Se reveló"), so it runs exactly once per event: with fewer than 2 countable finalists the contest is cancelled
 * and the organizers are told; afterwards losing finalists never cancels it (at the close 1 wins and 0 cancels).
 * `open` tells the reveal push whether to invite to vote.
 */
export async function settleContestAtReveal(
  env: Pick<Env, "DB">,
  trip: Pick<TripRow, "id" | "name" | "type" | "contest_enabled" | "contest_cancelled_at" | "contest_closed_at">,
  now: number,
): Promise<{ open: boolean; notify: AfterResponse }> {
  if (trip.type !== "event" || trip.contest_enabled !== 1 || trip.contest_cancelled_at !== null || trip.contest_closed_at !== null) {
    return { open: false, notify: null };
  }
  if ((await repo.countableFinalists(env.DB, trip.id)).length >= 2) return { open: true, notify: null };
  const cancelled = (await repo.claimCancel(env.DB, trip.id, now).run()).meta.changes > 0;
  return { open: false, notify: cancelled ? () => cancelledNotice(env, trip) : null };
}

/** Number of finalists that count (viewer-independent): the manual reveal needs at least 2. */
export async function countableFinalistCount(db: D1Database, tripId: string): Promise<number> {
  return (await repo.countableFinalists(db, tripId)).length;
}

/** Closes one contest past its window: single leader wins, no finalist cancels, a tie tells the organizers (daily). */
async function closeContest(env: Pick<Env, "DB">, trip: TripRow, now: number): Promise<void> {
  const db = env.DB;
  const { countable, leaders: top } = await leaders(db, trip.id);
  if (countable.length === 0) {
    if ((await repo.claimCancel(db, trip.id, now).run()).meta.changes > 0) await cancelledNotice(env, trip);
    return;
  }
  if (top.length === 1) {
    if ((await repo.claimClose(db, trip.id, top[0]!, now).run()).meta.changes > 0) await announceWinner(env, trip, top[0]!);
    return;
  }
  if ((await repo.claimTieNotice(db, trip.id, now).run()).meta.changes > 0) {
    await notifyOrganizers(env, trip, "Hay un empate en el concurso: elegí la ganadora", contestUrl(trip));
  }
}

/**
 * Cron: the organizers' notices (pick the finalists, reminder) and the close. Bounded (50 per query) and idempotent:
 * every push is sent by whoever flips its column with a conditional UPDATE, so two runs at once send it once.
 */
export async function runContestNotices(env: Pick<Env, "DB">, now = Date.now()): Promise<void> {
  const db = env.DB;
  for (const trip of await repo.listToAnnounceSelection(db, now)) {
    if ((await repo.claimSelectionNotice(db, trip.id, now).run()).meta.changes === 0) continue;
    await notifyOrganizers(env, trip, "Ya podés elegir las finalistas", picksUrl(trip));
  }
  for (const trip of await repo.listToRemind(db, now, CONTEST_REMINDER_LEAD_MS)) {
    if ((await repo.claimReminder(db, trip.id, now).run()).meta.changes === 0) continue;
    await notifyOrganizers(env, trip, "Elegí las finalistas del concurso antes del revelado", picksUrl(trip));
  }
  for (const trip of await repo.listToClose(db, now)) await closeContest(env, trip, now);
}

/** An organizer breaks the tie: only while `tied` (409) and only among the tied finalists (400). Closes and announces. */
export async function pickWinner(
  env: Pick<Env, "DB">,
  trip: TripRow,
  mediaId: string,
  now = Date.now(),
): Promise<{ notify: AfterResponse }> {
  contestOr404(trip);
  const { leaders: tied } = await leaders(env.DB, trip.id);
  if (contestStatus(trip, now, tied.length) !== "tied") throw conflict("El concurso no está empatado.");
  if (!tied.includes(mediaId)) throw badRequest("Esa foto no está entre las empatadas.");
  if ((await repo.claimClose(env.DB, trip.id, mediaId, now).run()).meta.changes === 0) throw conflict("El concurso no está empatado.");
  return { notify: () => announceWinner(env, trip, mediaId) };
}
