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
