import { badRequest, conflict, notFound } from "../../shared/errors";
import { resolveVariantKey, type MediaVariant } from "../../lib/media-variant";
import { avatarUrl, isRevealed } from "../../lib/util";
import type { MemberRow, TripRow } from "../../types";
import { contestStatus, closesAt, organizerPreviewOpen } from "./contest.rules";
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
  if (await repo.isFinalist(db, trip.id, mediaId)) return;
  const result = await repo.insertFinalist(db, trip.id, mediaId, now).run();
  if (result.meta.changes === 0 && !(await repo.isFinalist(db, trip.id, mediaId))) throw conflict("Ya hay 10 finalistas.");
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
    const countable = await repo.countableFinalists(db, trip.id);
    const tally = await repo.voteCounts(db, trip.id, countable);
    const top = Math.max(0, ...countable.map((id) => tally.get(id) ?? 0));
    tiedLeaders = countable.filter((id) => (tally.get(id) ?? 0) === top);
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
        author: { userId: row.authorUserId, name: row.authorName ?? "", avatarUrl: avatarUrl(row.authorUserId, row.authorAvatarKey) },
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
      author: { userId: f.authorUserId, name: f.authorName ?? "", avatarUrl: avatarUrl(f.authorUserId, f.authorAvatarKey) },
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
  await repo.upsertVote(db, trip.id, userId, mediaId, now).run();
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
