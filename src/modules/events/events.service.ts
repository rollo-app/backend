import { coverUrl, isRevealed } from "../../lib/util";
import { notFound } from "../../shared/errors";
import * as trips from "../trips/trips.repository";

/** Below this many active members the public preview hides the count, so a near-empty event does not show a tiny number to strangers. */
export const PUBLIC_MEMBER_COUNT_MIN = 5;

/** What someone sees before joining an event: no session needed. A code that does not exist or belongs to a regular trip is 404. */
export async function previewEvent(db: D1Database, code: string) {
  const trip = await trips.findTripByJoinCode(db, code);
  if (!trip || trip.type !== "event") throw notFound("Código inválido");
  const count = await trips.countActiveMembers(db, trip.id);
  const groups = (await trips.listGroups(db, trip.id)).map((g) => ({ id: g.id, name: g.name }));
  return {
    name: trip.name,
    coverUrl: coverUrl(trip),
    revealed: isRevealed(trip),
    memberCount: count >= PUBLIC_MEMBER_COUNT_MIN ? count : null,
    groups,
  };
}
