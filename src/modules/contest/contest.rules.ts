/** Pure rules of the photo contest (events only). No I/O: the services and the cron share them. */
import { isRevealed } from "../../lib/util";
import type { TripRow } from "../../types";

/** With the contest on, the reveal must come at least this long after the end, so the organizers can pick the finalists. */
export const CONTEST_MIN_REVEAL_GAP_MS = 2 * 3_600_000;

export const CONTEST_VOTING_HOURS_MIN = 24;
export const CONTEST_VOTING_HOURS_MAX = 336;
export const CONTEST_VOTING_HOURS_DEFAULT = 72;

export const CONTEST_GAP_MESSAGE =
  "Con concurso, el revelado tiene que ser al menos 2 horas después del fin, para que elijas las finalistas.";

/** True when `revealAt` leaves the organizers enough time after `endsAt` to pick the finalists. */
export function hasContestGap(endsAt: number, revealAt: number): boolean {
  return revealAt - endsAt >= CONTEST_MIN_REVEAL_GAP_MS;
}

/**
 * Organizers (active admins) of an event with the contest on can see and download every photo from `ends_at` until the
 * reveal, to pick the finalists. Guests, and organizers before the end, keep the "nothing before the reveal" rule.
 */
export function organizerPreviewOpen(
  trip: Pick<TripRow, "type" | "contest_enabled" | "ends_at" | "revealed_at" | "reveal_at">,
  member: { role: string },
  now: number,
): boolean {
  return (
    trip.type === "event" &&
    trip.contest_enabled === 1 &&
    member.role === "admin" &&
    now >= trip.ends_at &&
    !isRevealed(trip, now)
  );
}
