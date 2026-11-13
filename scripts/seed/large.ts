/** Same shape as `Shot` in lib.ts (not imported: lib.ts needs node types, and this file is pulled into the test typecheck). */
export type PartyShot = {
  member: number;
  type: "photo";
  takenAt: number;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  caption: string | null;
};

/** Pure helpers for the large-rollo seed (scripts/seed-large.ts). Kept free of I/O so they can be unit tested. */

export const GUEST_COUNT = 100;
export const guestName = (i: number) => `Invitado ${i}`;
/** Matches the guests' emails (slug of "Invitado N" → invitado.N@rollo.test) and nothing from the normal seed. */
export const GUEST_EMAIL_LIKE = "invitado.%@rollo.test";

export const LARGE_ROLLOS = {
  revealed: { name: "Fiesta grande", photos: 2000 },
  ongoing: { name: "Fiesta en curso", photos: 300 },
} as const;

/** Venue of the party (Palermo, Buenos Aires) and a few spots inside it, so the map clusters. */
export const VENUE = { lat: -34.5875, lng: -58.4297 };
const SPOTS = [
  { lat: 0, lng: 0, jitter: 0.00025 }, // dance floor
  { lat: 0.00018, lng: -0.00012, jitter: 0.00012 }, // bar
  { lat: -0.0002, lng: 0.00022, jitter: 0.00015 }, // patio
  { lat: 0.0003, lng: 0.0003, jitter: 0.0002 }, // entrance
];

export const CAPTIONS = [
  "la pista explotó",
  "brindis de las 12, nadie se salvó",
  "Nacho con el micrófono otra vez, auxilio",
  "el DJ se mandó un tema de 2008 y lloramos todos",
  "primera ronda de fernet, todavía somos personas",
  "la torta llegó entera (por ahora)",
  "selfie grupal número 37",
  "quién dejó a Agus a cargo de la música",
  "el patio a esta hora es otro mundo",
  "foto movida pero con mucho amor",
  "baile de los que no sabemos bailar",
  "alguien se llevó mi campera y me dejó la suya, un crack",
  "ya son las 4 y nadie se va",
  "cumpleañero feliz, bien acompañado",
  "la cola del baño merece su propia foto",
  "empanadas de madrugada, lo mejor de la noche",
  "esto es lo que pasa cuando se prende la luz",
  "los que quedamos al final",
  "mate para sobrevivir al amanecer",
  "me duelen los pies y volvería ahora mismo",
];

/**
 * `n` timestamps between `from` and `to`, denser towards the middle (the sum of two uniforms, a triangular distribution),
 * like a party that peaks in the middle of the night. Sorted ascending. `rng` returns [0, 1).
 */
export function spreadTimes(n: number, from: number, to: number, rng: () => number = Math.random): number[] {
  const span = to - from;
  return Array.from({ length: n }, () => from + Math.round(((rng() + rng()) / 2) * span)).sort((a, b) => a - b);
}

/** Plausible spot around the venue with small jitter; `null` for ~5% (no GPS). */
export function venueSpot(rng: () => number = Math.random): { lat: number; lng: number } | null {
  if (rng() < 0.05) return null;
  const s = SPOTS[Math.floor(rng() * SPOTS.length)]!;
  return { lat: VENUE.lat + s.lat + (rng() * 2 - 1) * s.jitter, lng: VENUE.lng + s.lng + (rng() * 2 - 1) * s.jitter };
}

/** `n` photo shots by `members` people (index into the member list), spread over [from, to]. */
export function planPartyShots(n: number, members: number, from: number, to: number, rng: () => number = Math.random): PartyShot[] {
  return spreadTimes(n, from, to, rng).map((takenAt) => {
    const spot = venueSpot(rng);
    return {
      member: Math.floor(rng() * members),
      type: "photo" as const,
      takenAt,
      lat: spot ? spot.lat : null,
      lng: spot ? spot.lng : null,
      accuracyM: spot ? 4 + Math.floor(rng() * 27) : null,
      caption: rng() < 0.4 ? CAPTIONS[Math.floor(rng() * CAPTIONS.length)]! : null,
    };
  });
}
