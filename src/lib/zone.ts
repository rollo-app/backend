/** Size of a zone cell in degrees (~5.5 km of latitude). */
export const ZONE_DEGREES = 0.05;
const CELLS_PER_DEGREE = 1 / ZONE_DEGREES; // 20: multiplying is exact where dividing by 0.05 is not (0.15 / 0.05 < 3)

const snap = (x: number) => Math.round((Math.floor(x * CELLS_PER_DEGREE) / CELLS_PER_DEGREE + ZONE_DEGREES / 2) * 1000) / 1000;

/**
 * Coarse location of a featured photo: the center of the 0.05° cell it falls in, to 3 decimals.
 * The exact coordinates never leave the rollo. Without GPS (either coordinate missing) → null.
 */
export function zoneOf(lat: number | null, lng: number | null): { lat: number; lng: number } | null {
  if (lat === null || lng === null) return null;
  return { lat: snap(lat), lng: snap(lng) };
}
