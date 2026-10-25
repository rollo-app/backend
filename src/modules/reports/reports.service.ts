import { sendReportEmail } from "../../lib/email";
import { atModerationActionCap, MODERATION_ACTION_CAP_MESSAGE, withinModerationEmailCap } from "../../lib/moderation";
import { canSeeProfile } from "../../lib/profile-access";
import { presignGet } from "../../lib/r2";
import { badRequest, notFound, rateLimited } from "../../shared/errors";
import type { Env, MediaRow, UserRow } from "../../types";
import { deleteFeatured } from "../featured/featured.repository";
import type { CreateReportInput } from "./reports.schemas";
import * as repo from "./reports.repository";

/** Whether the viewer may see the photo: active member of its trip, or a featured photo on a profile they can see. */
async function canSeeMedia(db: D1Database, viewerId: string, media: Pick<MediaRow, "id" | "trip_id">): Promise<boolean> {
  if (await repo.isActiveTripMember(db, media.trip_id, viewerId)) return true;
  const owners = await repo.listFeaturedOwners(db, media.id, Date.now());
  for (const owner of owners) if (await canSeeProfile(db, viewerId, owner)) return true;
  return false;
}

/** Stores a report (idempotent) and emails support within the caps. A reported photo leaves the reporter's featured list. */
export async function createReport(env: Env, viewer: UserRow, input: CreateReportInput, adminBase: string): Promise<void> {
  const db = env.DB;
  const { reason, mediaId, userId, commentId } = input;

  let targetId: string;
  let media: MediaRow | null = null;
  let comment: { id: string; media_id: string; user_id: string; text: string } | null = null;
  let commentTripId: string | null = null;
  if (commentId !== undefined) {
    // A comment is only visible to the active members of its photo's rollo (never through a profile).
    comment = await repo.findLiveComment(db, commentId);
    const commented = comment && (await repo.findUploadedMedia(db, comment.media_id));
    if (!comment || !commented || !(await repo.isActiveTripMember(db, commented.trip_id, viewer.id))) throw notFound();
    commentTripId = commented.trip_id;
    targetId = comment.user_id;
  } else if (mediaId !== undefined) {
    media = await repo.findUploadedMedia(db, mediaId);
    if (!media || !(await canSeeMedia(db, viewer.id, media))) throw notFound();
    const author = await repo.findMemberUserId(db, media.member_id);
    if (!author) throw notFound();
    targetId = author.user_id;
  } else {
    targetId = userId!;
  }

  const target = await repo.findReportTarget(db, targetId);
  if (!target) throw notFound();
  if (target.id === viewer.id) throw badRequest(
      commentId !== undefined ? "No podés denunciar tu propio comentario" : mediaId !== undefined ? "No podés denunciar tu propia foto" : "No podés denunciarte a vos mismo",
    );

  if (await atModerationActionCap(db, "reports", viewer.id)) throw rateLimited(MODERATION_ACTION_CAP_MESSAGE);
  // Starts flagged as not emailed: it is cleared once the email goes out (otherwise the daily summary lists it).
  const reportId = crypto.randomUUID();
  const inserted = await repo
    .insertReport(db, {
      id: reportId,
      reporterId: viewer.id,
      mediaId: media?.id ?? null,
      commentId: comment?.id ?? null,
      targetUserId: target.id,
      tripId: media?.trip_id ?? commentTripId,
      reason,
      createdAt: Date.now(),
    })
    .run();

  if (inserted.meta.changes === 1) {
    // A reported photo also leaves the reporter's own featured list (and its cap).
    if (media) await deleteFeatured(db, viewer.id, media.id).run();
    try {
      if (!(await withinModerationEmailCap(db, viewer.id))) return;
      const tripId = media?.trip_id ?? commentTripId;
      const trip = tripId ? await repo.findTripName(db, tripId) : null;
      await sendReportEmail(env, {
        reason,
        reporter: { id: viewer.id, name: viewer.name, username: viewer.username, email: viewer.email },
        target: { id: target.id, name: target.name, username: target.username, email: target.email },
        ...(trip && { trip: { name: trip.name } }),
        ...(comment && { comment: { id: comment.id, text: comment.text } }),
        ...(media && {
          media: {
            id: media.id,
            type: media.type,
            caption: media.caption,
            takenAt: media.taken_at,
            url: await presignGet(env, media.original_key),
          },
        }),
        adminBase,
      });
      await repo.markReportEmailed(db, reportId).run();
    } catch (err) {
      // The report is already saved; do not fail the request because support was not emailed.
      console.error("[report] could not email support", err);
    }
  }
}
