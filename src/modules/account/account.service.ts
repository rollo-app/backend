import { BACKFILL_CREATOR_SQL } from "../../lib/creator";
import type { Env, UserRow } from "../../types";
import * as repo from "./account.repository";

async function deleteR2Keys(bucket: R2Bucket, rows: { original_key: string; thumb_key: string }[]) {
  const keys = rows.flatMap((r) => [r.original_key, r.thumb_key]);
  // R2 deletes accept at most 1000 keys per call.
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}

/**
 * Permanently deletes an account: its media and memberships (handing the creator role on, or deleting emptied trips),
 * friendships, friend links, reports and blocks on both sides, push tokens, settings, likes, comments, avatar, sessions and login codes.
 */
export async function deleteAccount(env: Env, user: UserRow): Promise<void> {
  const { DB, MEDIA } = env;

  for (const m of await repo.listMemberships(DB, user.id)) {
    await deleteR2Keys(MEDIA, await repo.listMemberMediaKeys(DB, m.id));
    await DB.batch([repo.deleteMemberMedia(DB, m.id), repo.deleteMember(DB, m.id)]);

    const next = await repo.listActiveTripMembers(DB, m.trip_id);

    if (next.length === 0) {
      await deleteR2Keys(MEDIA, await repo.listTripMediaKeys(DB, m.trip_id));
      await DB.batch([repo.deleteTripMedia(DB, m.trip_id), repo.deleteTripMembers(DB, m.trip_id), repo.deleteTrip(DB, m.trip_id)]);
    } else {
      // If the creator is gone, the oldest active admin takes over (with none, the oldest active member, promoted to admin).
      // One batch (a transaction): the backfill only touches trips whose creator is NULL.
      await DB.batch([repo.clearCreatorIfUser(DB, m.trip_id, user.id), ...BACKFILL_CREATOR_SQL.map((sql) => DB.prepare(sql).bind(m.trip_id))]);
    }
  }

  const avatars = [user.avatar_key, user.pending_avatar_key].filter((k): k is string => k !== null);
  if (avatars.length) await MEDIA.delete(avatars);

  await DB.batch(repo.deleteUserData(DB, user));
}
