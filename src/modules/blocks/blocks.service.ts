import { sendBlockEmail } from "../../lib/email";
import { pairKey } from "../../lib/friend-code";
import { atModerationActionCap, MODERATION_ACTION_CAP_MESSAGE, withinModerationEmailCap } from "../../lib/moderation";
import { badRequest, notFound, rateLimited } from "../../shared/errors";
import type { Env, UserRow } from "../../types";
import * as repo from "./blocks.repository";

export function listBlocked(db: D1Database, blockerId: string): Promise<repo.BlockedUserRow[]> {
  return repo.listBlocked(db, blockerId);
}

/** Idempotent block. Also removes the friendship and the blocked user's photos from the blocker's featured list. */
export async function blockUser(env: Env, blocker: UserRow, targetId: string, adminBase: string): Promise<void> {
  const me = blocker.id;
  const db = env.DB;
  if (targetId === me) throw badRequest("No podés bloquearte");
  const blocked = await repo.findBlockTarget(db, targetId);
  if (!blocked) throw notFound("No existe ese usuario");
  if (await atModerationActionCap(db, "blocks", me)) throw rateLimited(MODERATION_ACTION_CAP_MESSAGE);
  const [a, b] = pairKey(me, targetId);
  const [inserted] = await db.batch([
    repo.insertBlock(db, me, targetId, Date.now()),
    repo.deleteFriendship(db, a, b),
    repo.deleteFeaturedByAuthor(db, me, targetId),
  ]);
  if (inserted!.meta.changes === 1 && (await withinModerationEmailCap(db, me))) {
    try {
      await sendBlockEmail(env, {
        blocker: { id: blocker.id, name: blocker.name, username: blocker.username, email: blocker.email },
        blocked: { id: blocked.id, name: blocked.name, username: blocked.username, email: blocked.email },
        adminBase,
      });
      await repo.markBlockEmailed(db, me, targetId).run();
    } catch (err) {
      // The block is already saved; do not fail the request because support was not emailed.
      console.error("[block] could not email support", err);
    }
  }
}

export async function unblockUser(db: D1Database, blockerId: string, blockedId: string): Promise<void> {
  await repo.deleteBlock(db, blockerId, blockedId).run();
}
