import { coverUrl, isRevealed } from "../../lib/util";
import { notFound } from "../../shared/errors";
import * as trips from "../trips/trips.repository";

/** Below this many active members the public preview hides the count, so a near-empty event does not show a tiny number to strangers. */
export const PUBLIC_MEMBER_COUNT_MIN = 5;

/** What someone sees before joining a rollo (event or regular): no session needed. A code that does not exist is 404, and so is a regular trip unless `includeTrips`. */
export async function previewEvent(db: D1Database, code: string, includeTrips = false) {
  const trip = await trips.findTripByJoinCode(db, code);
  // A regular trip is opt-in (`any=1`): installed builds read any 200 here as an event, so for them it stays a 404.
  if (!trip || (trip.type !== "event" && !includeTrips)) throw notFound("Código inválido");
  const count = await trips.countActiveMembers(db, trip.id);
  const groups = trip.type === "event" ? (await trips.listGroups(db, trip.id)).map((g) => ({ id: g.id, name: g.name })) : [];
  return {
    type: trip.type,
    name: trip.name,
    coverUrl: coverUrl(trip),
    description: trip.description,
    startsAt: trip.starts_at,
    endsAt: trip.ends_at,
    timezone: trip.timezone,
    revealed: isRevealed(trip),
    memberCount: count >= PUBLIC_MEMBER_COUNT_MIN ? count : null,
    groups,
  };
}
