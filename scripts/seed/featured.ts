import { API, api, d1, ensureUser, seedUserId } from "./lib";
import { FEATURED_TRIP, type SeedPhoto, planFeatured } from "./people";

/**
 * Featured photos (see `planFeatured`): Cami blocks one of her Bariloche photos, Juani and Tomi feature theirs.
 * Idempotent: every run clears Juani's and Tomi's featured rows and features them again through the API.
 */
export async function seedFeatured() {
  const [trip] = d1<{ id: string }>(`SELECT id FROM trips WHERE name = '${FEATURED_TRIP.replace(/'/g, "''")}'`);
  if (!trip) throw new Error(`Featured: trip "${FEATURED_TRIP}" not found`);
  const photos = d1<SeedPhoto>(
    `SELECT m.id, u.name AS author FROM media m JOIN members mem ON mem.id = m.member_id JOIN users u ON u.id = mem.user_id
     WHERE m.trip_id = '${trip.id}' AND m.type = 'photo' AND m.status = 'uploaded' AND m.deleted_at IS NULL
     ORDER BY m.taken_at, m.id`,
  );
  const plan = planFeatured(photos);

  if (plan.blocked) await api("PUT", `/media/${plan.blocked}/feature-block`, undefined, await ensureUser("Cami"));
  for (const [name, ids] of Object.entries(plan.byUser)) {
    d1(`DELETE FROM featured WHERE user_id = '${seedUserId(name)}'`);
    const token = await ensureUser(name);
    for (const id of ids) await api("PUT", `/me/featured/${id}`, undefined, token);
  }
  return plan;
}

type FeaturedPhoto = { mediaId: string; author: { name: string } | null; zone: unknown; thumbPath: string } & Record<string, unknown>;

/** Checks Juani's and Tomi's featured photos as their friends and strangers would see them. Throws on any mismatch. */
export async function verifyFeatured(plan: Awaited<ReturnType<typeof seedFeatured>>) {
  const problems: string[] = [];
  const [juani, cami, nuevo] = await Promise.all(["Juani", "Cami", "Nuevo"].map(ensureUser));
  const get = (path: string, token: string) => fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });

  const mine = await api<{ photos: FeaturedPhoto[] }>("GET", `/users/${seedUserId("Juani")}/featured`, undefined, juani);
  const expected = plan.byUser.Juani!;
  if (mine.photos.length !== expected.length) problems.push(`Juani: ${mine.photos.length} featured (expected ${expected.length})`);
  const byOthers = mine.photos.filter((p) => p.author !== null).length;
  if (byOthers < 2) problems.push(`Juani: ${byOthers} featured by others (expected at least 2)`);
  if (plan.blocked && mine.photos.some((p) => p.mediaId === plan.blocked)) problems.push("Juani: shows Cami's blocked photo");
  for (const p of mine.photos) {
    const leaked = ["tripId", "caption", "lat", "lng"].filter((k) => k in p);
    if (leaked.length) problems.push(`Juani: featured photo leaks ${leaked.join(", ")}`);
  }

  const file = mine.photos[0] && (await get(mine.photos[0].thumbPath, cami));
  if (file && file.status !== 200) problems.push(`Cami (friend) gets ${file.status} for Juani's featured thumb`);

  const stranger = await get(`/users/${seedUserId("Juani")}/featured`, nuevo);
  if (stranger.status !== 403) problems.push(`Nuevo (stranger) gets ${stranger.status} for Juani's private featured (expected 403)`);
  const tomi = await get(`/users/${seedUserId("Tomi")}/featured`, nuevo);
  const tomiPhotos = tomi.ok ? ((await tomi.json()) as { photos: unknown[] }).photos.length : -1;
  if (tomiPhotos !== plan.byUser.Tomi!.length) {
    problems.push(`Nuevo (stranger) sees ${tomiPhotos} of Tomi's public featured (status ${tomi.status}, expected ${plan.byUser.Tomi!.length})`);
  }

  if (problems.length) throw new Error(`Featured check failed:\n  ${problems.join("\n  ")}`);
  console.log(
    `✓ featured: Juani ${mine.photos.length} (${byOthers} by others, private), Tomi ${tomiPhotos} (public), Cami's blocked photo hidden`,
  );
}
