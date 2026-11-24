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

export type ContestStatus = "pending" | "selecting" | "voting" | "closing" | "tied" | "closed" | "cancelled";

type ClosingFields = Pick<TripRow, "revealed_at" | "reveal_at" | "contest_voting_hours">;

/** When the voting ends: the reveal (manual or scheduled) plus the voting window. Computed, never stored. */
export function closesAt(trip: ClosingFields): number {
  return (trip.revealed_at ?? trip.reveal_at) + trip.contest_voting_hours * 3_600_000;
}

/**
 * Stage of the contest at `now`. After the voting window it is `tied` when two or more countable finalists share the
 * top vote count (`topTied`, viewer-independent, 0-0 included) and `closing` otherwise (the cron has not closed it yet).
 */
export function contestStatus(
  trip: ClosingFields & Pick<TripRow, "ends_at" | "contest_cancelled_at" | "contest_closed_at">,
  now: number,
  topTied = 0,
): ContestStatus {
  if (trip.contest_cancelled_at !== null) return "cancelled";
  if (trip.contest_closed_at !== null) return "closed";
  if (now < trip.ends_at) return "pending";
  if (!isRevealed(trip, now)) return "selecting";
  if (now < closesAt(trip)) return "voting";
  return topTied >= 2 ? "tied" : "closing";
}
