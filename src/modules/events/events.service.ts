import { coverUrl, isRevealed } from "../../lib/util";
import { notFound } from "../../shared/errors";
import * as trips from "../trips/trips.repository";

/** What someone sees before joining an event: no session needed. A code that does not exist or belongs to a regular trip is 404. */
export async function previewEvent(db: D1Database, code: string) {
  const trip = await trips.findTripByJoinCode(db, code);
  if (!trip || trip.type !== "event") throw notFound("Código inválido");
  const groups = (await trips.listGroups(db, trip.id)).map((g) => ({ id: g.id, name: g.name }));
  return { name: trip.name, coverUrl: coverUrl(trip), revealed: isRevealed(trip), groups };
}
