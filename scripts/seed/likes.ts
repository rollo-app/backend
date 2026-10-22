import { api, d1, ensureUser } from "./lib";
import { FEATURED_TRIP, type PlannedLike, type SeedPhoto, planLikes } from "./people";

/**
 * Likes on Bariloche's photos (see `planLikes`), given through the real API so they follow its rules.
 * Idempotent: every run clears the likes (and the push anti-spam window) of that trip's photos and gives them again.
 * Seed users have no push tokens, so nothing is sent to Expo.
 */
export async function seedLikes(): Promise<{ tripId: string; plan: PlannedLike[] }> {
  const [trip] = d1<{ id: string }>(`SELECT id FROM trips WHERE name = '${FEATURED_TRIP.replace(/'/g, "''")}'`);
  if (!trip) throw new Error(`Likes: trip "${FEATURED_TRIP}" not found`);
  const photos = d1<SeedPhoto>(
    `SELECT m.id, u.name AS author FROM media m JOIN members mem ON mem.id = m.member_id JOIN users u ON u.id = mem.user_id
     WHERE m.trip_id = '${trip.id}' AND m.type = 'photo' AND m.status = 'uploaded' AND m.deleted_at IS NULL
     ORDER BY m.taken_at, m.id`,
  );
  const members = d1<{ name: string }>(
    `SELECT u.name FROM members mem JOIN users u ON u.id = mem.user_id
     WHERE mem.trip_id = '${trip.id}' AND mem.removed_at IS NULL AND mem.left_at IS NULL`,
  ).map((m) => m.name);
  const plan = planLikes(photos, members);

  d1(`DELETE FROM likes WHERE media_id IN (SELECT id FROM media WHERE trip_id = '${trip.id}')`);
  d1(`UPDATE media SET like_notified_at = NULL, likes_since_notified = 0 WHERE trip_id = '${trip.id}'`);
  for (const like of plan) await api("PUT", `/media/${like.mediaId}/like`, undefined, await ensureUser(like.user));
  return { tripId: trip.id, plan };
}

type FeedItem = { id: string; likeCount?: number; likedByMe?: boolean };

/** Checks the counts and likedByMe in Juani's revealed feed against the plan. Throws on any mismatch. */
export async function verifyLikes({ tripId, plan }: Awaited<ReturnType<typeof seedLikes>>) {
  const feed = await api<{ items: FeedItem[] }>("GET", `/trips/${tripId}/feed`, undefined, await ensureUser("Juani"));
  const problems: string[] = [];
  const expected = new Map<string, number>();
  for (const l of plan) expected.set(l.mediaId, (expected.get(l.mediaId) ?? 0) + 1);
  for (const item of feed.items) {
    const count = expected.get(item.id) ?? 0;
    if (item.likeCount !== count) problems.push(`${item.id}: likeCount ${item.likeCount} (expected ${count})`);
    const mine = plan.some((l) => l.user === "Juani" && l.mediaId === item.id);
    if (item.likedByMe !== mine) problems.push(`${item.id}: likedByMe ${item.likedByMe} (expected ${mine})`);
  }
  if (problems.length) throw new Error(`Likes check failed:\n  ${problems.join("\n  ")}`);
  console.log(`✓ likes: ${plan.length} on ${expected.size} Bariloche photos (Juani's first has ${Math.max(...expected.values(), 0)})`);
}
