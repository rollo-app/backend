/**
 * Seed people: bios, friendships and the "rollos en común" each friend of Juani must have.
 * Pure data and logic (no node APIs), so it is unit tested in test/seed-people.test.ts.
 */

/** Profile descriptions (set through PATCH /me). Everyone else gets none. */
export const SEED_BIOS: Record<string, string> = {
  Juani: "Armando el rollo del sur, enero 2027",
  Cami: "Mate, montaña y fotos movidas",
  // Exactly 150 characters: the limit.
  Tomi: "Cebador oficial del grupo y encargado de perder el mapa en cada sendero. Si hay alfajores, avisen. Si hay subida, también, así me preparo mentalmente.",
  Fede: "Ingeniero de día\nCocinero de guiso en refugios\nSiempre el último en llegar a la cumbre",
  Bruno: "Escalador de fin de semana\nFotógrafo de todo el año",
};

/**
 * Symmetric friendships. From Juani's point of view:
 * - Cami, Tomi, Fede: several rollos in common.
 * - Pilar: friend with no rollos at all.
 * - Bruno: one rollo with Juani (Finde en Tandil) and one without (Escapada sin Juani), which must not show up.
 * - Rama: left Finde en Tandil (left_at). Vicky: Juani (admin) removed her from it (removed_at). Neither counts.
 * Lu, Nacho, Sofi... share rollos with Juani but are NOT friends; Lu's friend link is printed so Juani can add her.
 */
export const SEED_FRIENDSHIPS: [string, string][] = [
  ["Juani", "Cami"],
  ["Juani", "Tomi"],
  ["Juani", "Fede"],
  ["Juani", "Pilar"],
  ["Juani", "Bruno"],
  ["Juani", "Rama"],
  ["Juani", "Vicky"],
  ["Cami", "Tomi"],
  ["Cami", "Bruno"],
];

/** Seed users with a name but no username (accounts from before usernames): the app sends them to "Completá tu perfil". */
export const NO_USERNAME = new Set(["Rocío"]);

export type CommonExpectation = { exactly?: string[]; atLeast?: number; excludes?: string[] };

const PRIVATE_TRIP = "Escapada sin Juani";

/** What GET /friends/{id} must return as commonTrips (by trip name) for each friend of Juani. */
export const EXPECTED_COMMON: Record<string, CommonExpectation> = {
  Cami: { atLeast: 5, excludes: [PRIVATE_TRIP] },
  Tomi: { atLeast: 5, excludes: [PRIVATE_TRIP] },
  Fede: { atLeast: 5, excludes: [PRIVATE_TRIP] },
  Pilar: { exactly: [] },
  Bruno: { exactly: ["Finde en Tandil"] },
  Rama: { exactly: [] },
  Vicky: { exactly: [] },
};

/** null if the trip names match the expectation, otherwise a short description of what is wrong. */
export function commonTripsProblem(expected: CommonExpectation, names: string[]): string | null {
  if (expected.exactly) {
    const missing = expected.exactly.filter((n) => !names.includes(n));
    const extra = names.filter((n) => !expected.exactly!.includes(n));
    if (missing.length || extra.length) return `missing [${missing.join(", ")}], extra [${extra.join(", ")}]`;
  }
  if (expected.atLeast !== undefined && names.length < expected.atLeast) {
    return `expected at least ${expected.atLeast} trips, got ${names.length}`;
  }
  const leaked = (expected.excludes ?? []).filter((n) => names.includes(n));
  if (leaked.length) return `must not include [${leaked.join(", ")}]`;
  return null;
}

export type TripTimes = { startsAt: number; endsAt: number; revealAt: number; revealedAt: number | null };

/** Phase of a trip at `now`, as the summary prints it (same reveal rule as the API's isRevealed). */
export function tripPhase(t: TripTimes, now = Date.now()): string {
  if (t.revealedAt !== null || now >= t.revealAt) return "revelado";
  if (now < t.startsAt) return "por empezar";
  if (now < t.endsAt) return "en curso";
  return "terminado, sin revelar";
}

/** Seed users that are NOT exempt from the limits on creating rollos (`users.unlimited_rollos`): "Nuevo" creates nothing in the seed, so it is the one to try the limits with. Everyone else creates several rollos. */
export const LIMITED_ROLLOS = new Set(["Nuevo"]);

/** Seed users with a public profile (anyone signed in sees their featured photos and bio). Everyone else: "friends". */
export const PUBLIC_PROFILES = new Set(["Tomi"]);

/** The revealed rollo whose photos get featured. */
export const FEATURED_TRIP = "Bariloche 2025 (revelado)";

export type SeedPhoto = { id: string; author: string };
export type FeaturedPlan = { blocked: string | null; byUser: Record<string, string[]> };

/**
 * Featured photos of the seed, from FEATURED_TRIP's photos (in time order):
 * - Cami doesn't let others feature her first photo (feature block).
 * - Juani: 2 by others (Tomi's and Fede's first) and 3 of her own; if she has fewer than 3, friends' photos fill in up to 5.
 * - Tomi (public profile): 1 of Juani's (if any) and 2 of his own.
 * Nobody but its author ever gets the blocked photo. The order is the order they are featured in (last = newest).
 */
export function planFeatured(photos: SeedPhoto[]): FeaturedPlan {
  const blocked = photos.find((p) => p.author === "Cami")?.id ?? null;
  const by = (author: string) => photos.filter((p) => p.author === author && p.id !== blocked).map((p) => p.id);

  const juani = [by("Tomi")[0], by("Fede")[0]].filter((id): id is string => id !== undefined);
  const own = by("Juani").slice(0, 3);
  // Only friends' photos can be featured, so the fill skips people who are not friends of Juani (Lu, Nacho...).
  const friendsOfJuani = new Set(SEED_FRIENDSHIPS.flatMap(([a, b]) => (a === "Juani" ? [b] : b === "Juani" ? [a] : [])));
  const fill = photos.filter((p) => friendsOfJuani.has(p.author) && p.id !== blocked && !juani.includes(p.id)).map((p) => p.id);
  juani.push(...fill.slice(0, Math.max(0, 5 - juani.length - own.length)), ...own);

  const tomi = [...by("Juani").slice(0, 1), ...by("Tomi").slice(0, 2)];
  return { blocked, byUser: { Juani: juani, Tomi: tomi } };
}

export type PlannedLike = { user: string; mediaId: string };

/**
 * Likes of the seed, on FEATURED_TRIP's photos (in time order), so the app shows counts in the gallery and on profiles:
 * - Juani's first photo: every other member (5 with the usual members).
 * - Tomi's first photo (featured by Juani and by Tomi): Juani and Cami.
 * - Fede's first photo (featured by Juani): Juani.
 * Nobody likes their own photo here; only `members` like.
 */
export function planLikes(photos: SeedPhoto[], members: string[]): PlannedLike[] {
  const first = (author: string) => photos.find((p) => p.author === author)?.id;
  const plan: PlannedLike[] = [];
  const add = (mediaId: string | undefined, author: string, users: string[]) => {
    if (!mediaId) return;
    for (const user of users) if (user !== author && members.includes(user)) plan.push({ user, mediaId });
  };
  add(first("Juani"), "Juani", members);
  add(first("Tomi"), "Tomi", ["Juani", "Cami"]);
  add(first("Fede"), "Fede", ["Juani"]);
  return plan;
}

/** Profile badges (assigned by hand in production; the seed sets them straight in D1). Everyone else: none. */
export const SEED_BADGES: Record<string, "founder" | "first_edition"> = {
  Juani: "founder",
  Cami: "first_edition",
  Lu: "first_edition",
};
