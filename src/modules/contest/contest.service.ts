import { badRequest, conflict, notFound } from "../../shared/errors";
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
  const [result] = await db.batch([repo.insertFinalist(db, trip.id, mediaId, now)]);
  if (result!.meta.changes === 0 && !(await repo.isFinalist(db, trip.id, mediaId))) throw conflict("Ya hay 10 finalistas.");
}

export async function removeFinalist(db: D1Database, trip: TripRow, member: MemberRow, mediaId: string, now = Date.now()) {
  assertSelectionOpen(trip, member, now);
  await repo.deleteFinalist(db, trip.id, mediaId).run();
}

export async function getContest(db: D1Database, trip: TripRow, member: MemberRow, viewerUserId: string, now = Date.now()) {
  if (trip.type !== "event" || trip.contest_enabled !== 1) throw notFound(NO_CONTEST);
  const status = contestStatus(trip, now);
  // Guests only see the finalists once the event is revealed; organizers see them while choosing.
  const visible = isRevealed(trip, now) || member.role === "admin";
  const finalists = visible && status !== "cancelled" ? await repo.validFinalists(db, trip.id, viewerUserId) : [];
  const ids = finalists.map((f) => f.mediaId);

  const counts = status === "closed" || status === "tied" ? await repo.voteCounts(db, trip.id, ids) : new Map<string, number>();
  let tiedMediaIds: string[] = [];
  if (status === "tied" && ids.length > 0) {
    const top = Math.max(...ids.map((id) => counts.get(id) ?? 0));
    tiedMediaIds = ids.filter((id) => (counts.get(id) ?? 0) === top);
  }

  const mine = await repo.getMyVote(db, trip.id, viewerUserId);
  const base = (id: string) => `/trips/${trip.id}/contest/finalists/${id}`;

  let winner = null;
  if (status === "closed" && trip.contest_winner_media_id) {
    const row = await repo.findWinner(db, trip.contest_winner_media_id);
    if (row) {
      winner = {
        mediaId: row.mediaId,
        author: { userId: row.authorUserId, name: row.authorName ?? "", avatarUrl: avatarUrl(row.authorUserId, row.authorAvatarKey) },
        imageAvailable: row.available === 1,
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
