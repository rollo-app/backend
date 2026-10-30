import type { AfterResponse } from "../../shared/after-response";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors";
import { CREATOR_ONLY, isCreator } from "../../lib/creator";
import { blockedIdsFor } from "../blocks/blocks.service";
import { sendTripRevealed } from "./notices.service";
import { assertNotDegraded } from "../../lib/degraded";
import { generateJoinCode, isRevealed, localDate, publicTrip } from "../../lib/util";
import { PAST_TOLERANCE_MS } from "../../schemas";
import { deleteUntakenMomentsAfter, deleteUntakenMomentsOn } from "../moments/moments.repository";
import type { Env, MemberRow, Role, TripRow, UserRow } from "../../types";
import { deleteFeaturedOfTrip } from "../featured/featured.repository";
import { requireName } from "./members.service";
import * as repo from "./trips.repository";
import type { ActiveMemberRow } from "./trips.repository";
import { MAX_TRIP_DURATION_MS, TRIP_TOO_LONG } from "./trips.schemas";
import type { CreateTripInput, UpdateTripInput } from "./trips.schemas";

// ---------- Create ----------

export const MAX_UNREVEALED_CREATED = 2;
export const MAX_CREATED_IN_WINDOW = 4;
export const CREATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** "3 de noviembre" in the given time zone. */
function spanishDate(ms: number, timeZone: string): string {
  const [, month = 1, day = 1] = localDate(ms, timeZone).split("-").map(Number);
  return `${day} de ${MONTHS[month - 1]}`;
}

/** Limits on rollos the user created (as admin); joined or added ones never count. */
async function enforceCreateLimits(db: D1Database, userId: string, timeZone: string, now: number) {
  const unrevealed = await repo.countUnrevealedCreated(db, userId, now);
  if (unrevealed >= MAX_UNREVEALED_CREATED) {
    throw conflict(`Ya tenés ${MAX_UNREVEALED_CREATED} rollos sin revelar. Esperá a que se revele uno para crear otro.`);
  }
  const recent = await repo.createdSince(db, userId, now - CREATE_WINDOW_MS);
  if (recent.length >= MAX_CREATED_IN_WINDOW) {
    // Creating again needs the count to drop below the max: the 4th most recent has to turn 30 days.
    const blocking = recent[recent.length - MAX_CREATED_IN_WINDOW]!;
    throw conflict(
      `Ya creaste ${MAX_CREATED_IN_WINDOW} rollos en los últimos 30 días. Vas a poder crear otro el ${spanishDate(blocking + CREATE_WINDOW_MS, timeZone)}.`,
    );
  }
}

/** Creates the trip with `user` as admin. `null` when no free join code could be generated. */
export async function createTrip(
  db: D1Database,
  user: UserRow,
  body: CreateTripInput,
  hooks: { beforeInsert?: () => Promise<void> } = {},
): Promise<{ trip: TripRow; member: Pick<MemberRow, "id" | "user_id" | "role"> } | null> {
  requireName(user);
  await assertNotDegraded({ DB: db });
  const now = Date.now();
  const limited = !user.unlimited_rollos;
  // Early check for a clear error; the INSERT below re-checks atomically.
  if (limited) await enforceCreateLimits(db, user.id, body.timezone, now);

  // Unique code (collisions are very unlikely, but we retry just in case).
  let joinCode = "";
  for (let i = 0; i < 5 && !joinCode; i++) {
    const candidate = generateJoinCode();
    if (!(await repo.joinCodeExists(db, candidate))) joinCode = candidate;
  }
  if (!joinCode) return null;

  const tripId = crypto.randomUUID();
  const memberId = crypto.randomUUID();

  await hooks.beforeInsert?.();

  await db.batch([
    repo.insertTrip(db, {
      id: tripId,
      name: body.name,
      join_code: joinCode,
      timezone: body.timezone,
      starts_at: body.startsAt,
      ends_at: body.endsAt,
      reveal_at: body.revealAt,
      daily_photo_limit: body.dailyPhotoLimit,
      daily_video_limit: body.dailyVideoLimit,
      photo_limit_mode: body.photoLimitMode,
      total_photo_limit: body.photoLimitMode === "total" ? body.totalPhotoLimit! : null,
      created_at: now,
      // Starting now ("Empezar ahora"): the creator is the only member and just did it, so no "Arrancó" push.
      started_notified_at: body.startsAt <= now ? now : null,
      featuring_disabled: body.featuringDisabled ? 1 : 0,
      moment_mode: body.momentMode,
      moment_window_start: body.momentWindowStart,
      moment_window_end: body.momentWindowEnd,
    }, {
      userId: user.id,
      limited,
      unrevealedMax: MAX_UNREVEALED_CREATED,
      windowMax: MAX_CREATED_IN_WINDOW,
      windowSince: now - CREATE_WINDOW_MS,
    }),
    repo.insertAdminMember(db, memberId, tripId, user.id, now),
  ]);

  const trip = await repo.findTripById(db, tripId);
  if (!trip) {
    // The guarded INSERT wrote nothing: a concurrent create used the last slot. Say which limit hit.
    await enforceCreateLimits(db, user.id, body.timezone, Date.now());
    throw conflict("No pudimos crear el rollo ahora. Probá de nuevo.");
  }
  return { trip, member: { id: memberId, user_id: user.id, role: "admin" as Role } };
}

/** The rollo's creator as the API shows it (null if unknown). */
export const getCreator = repo.findCreator;

// ---------- Detail ----------

export type TripDetail = {
  members: ActiveMemberRow[];
  blocked: Set<string>;
  today: { date: string; photosLeft: number; videosLeft: number };
  totalUploaded: number;
};

/** Photos per person that apply to this rollo: per day or for the whole rollo. */
function photoLimit(trip: TripRow): number {
  return trip.photo_limit_mode === "total" ? (trip.total_photo_limit ?? 0) : trip.daily_photo_limit;
}

/** Active members, how many photos and videos `me` has left today, and how much has been uploaded. */
export async function getTripDetail(db: D1Database, trip: TripRow, me: MemberRow, userId: string): Promise<TripDetail> {
  const now = Date.now();
  const today = localDate(now, trip.timezone);

  const [members, usage, totals, blocked] = await Promise.all([
    repo.listActiveMembers(db, trip.id),
    trip.photo_limit_mode === "total" ? repo.countMediaByTypeTotal(db, me.id) : repo.countMediaByType(db, me.id, today),
    repo.countUploadedMedia(db, trip.id, me.id),
    blockedIdsFor(db, userId),
  ]);

  // Outside the rollo's dates (or once revealed) nothing can be shot.
  const active = now >= trip.starts_at && now <= trip.ends_at && !isRevealed(trip, now);
  const used = (type: string) => usage.results.find((r) => r.type === type)?.n ?? 0;

  return {
    members: members.results,
    blocked,
    today: {
      date: today,
      photosLeft: !active ? 0 : Math.max(0, photoLimit(trip) - used("photo")),
      videosLeft: !active ? 0 : Math.max(0, trip.daily_video_limit - used("video")),
    },
    totalUploaded: totals?.n ?? 0,
  };
}

// ---------- Edit (admin) ----------

/** Applies the edit and returns the updated trip. Any admin edits dates, quota and moment; only the creator toggles the private rollo. */
export async function updateTrip(db: D1Database, trip: TripRow, actorUserId: string, b: UpdateTripInput): Promise<TripRow> {
  if (b.featuringDisabled !== undefined && !isCreator(trip, actorUserId)) throw forbidden(CREATOR_ONLY);

  const now = Date.now();
  const stage = isRevealed(trip, now) || now > trip.ends_at ? "ended" : now >= trip.starts_at ? "active" : "upcoming";

  // Only fields that carry a new value count as edited: a client re-sending what is stored changes nothing.
  const photoLimitMode = b.photoLimitMode ?? trip.photo_limit_mode;
  const totalPhotoLimit = photoLimitMode === "total" ? (b.totalPhotoLimit ?? trip.total_photo_limit) : null;
  const next = {
    name: b.name ?? trip.name,
    starts_at: b.startsAt ?? trip.starts_at,
    ends_at: b.endsAt ?? trip.ends_at,
    reveal_at: b.revealAt ?? trip.reveal_at,
    daily_photo_limit: b.dailyPhotoLimit ?? trip.daily_photo_limit,
    daily_video_limit: b.dailyVideoLimit ?? trip.daily_video_limit,
    photo_limit_mode: photoLimitMode,
    total_photo_limit: totalPhotoLimit,
    featuring_disabled: b.featuringDisabled === undefined ? trip.featuring_disabled : b.featuringDisabled ? 1 : 0,
    moment_mode: b.momentMode ?? trip.moment_mode,
    moment_window_start: b.momentWindowStart ?? trip.moment_window_start,
    moment_window_end: b.momentWindowEnd ?? trip.moment_window_end,
  };
  const startChanged = next.starts_at !== trip.starts_at;
  const endChanged = next.ends_at !== trip.ends_at;
  const revealChanged = next.reveal_at !== trip.reveal_at;
  const modeChanged = next.photo_limit_mode !== trip.photo_limit_mode;
  const quotaChanged =
    next.daily_photo_limit !== trip.daily_photo_limit || next.daily_video_limit !== trip.daily_video_limit || next.total_photo_limit !== trip.total_photo_limit;
  const momentChanged =
    next.moment_mode !== trip.moment_mode || next.moment_window_start !== trip.moment_window_start || next.moment_window_end !== trip.moment_window_end;

  if (stage === "ended" && (startChanged || endChanged || revealChanged || modeChanged || quotaChanged || momentChanged)) {
    throw conflict("El rollo ya terminó: no se puede editar");
  }
  if (stage === "active" && startChanged) throw conflict("El rollo ya empezó: el inicio no se cambia");
  if (stage === "active" && modeChanged) throw conflict("El rollo ya empezó: el tipo de cupo no se cambia");

  // Only the values being changed are checked against the clock and the caps, so an existing rollo keeps working.
  const earliest = now - PAST_TOLERANCE_MS;
  if (startChanged && next.starts_at < earliest) throw badRequest("El inicio no puede ser en el pasado");
  if (endChanged && next.ends_at < earliest) throw badRequest("El fin no puede ser en el pasado");
  if (revealChanged && next.reveal_at < earliest) throw badRequest("El revelado no puede ser en el pasado");
  if (next.ends_at <= next.starts_at) throw badRequest("El rollo tiene que terminar después de empezar");
  if ((startChanged || endChanged) && next.ends_at - next.starts_at > MAX_TRIP_DURATION_MS) throw badRequest(TRIP_TOO_LONG);
  if (next.reveal_at < next.ends_at) throw badRequest("El revelado no puede ser antes del fin");
  if ((b.momentWindowStart !== undefined || b.momentWindowEnd !== undefined) && next.moment_window_end - next.moment_window_start < 30) {
    throw badRequest("La franja del momento tiene que durar al menos 30 minutos");
  }
  if (next.photo_limit_mode === "total" && next.total_photo_limit === null) throw badRequest("Elegí cuántas fotos por persona tiene el rollo");

  const statements: D1PreparedStatement[] = [repo.updateTrip(db, trip.id, next)];
  // A private rollo takes its photos off every profile (the authors' own too); turning it off restores nothing.
  if (next.featuring_disabled !== 0 && trip.featuring_disabled === 0) statements.push(deleteFeaturedOfTrip(db, trip.id));
  // New dates or moment config: the future moments nobody took are drawn again. Today's one stays (it was or will be
  // notified), unless the new end leaves no room for its 15 minutes; in a rollo that has not started, today's goes too.
  if (startChanged || endChanged || momentChanged) {
    const today = localDate(now, trip.timezone);
    statements.push(deleteUntakenMomentsAfter(db, trip.id, today));
    statements.push(deleteUntakenMomentsOn(db, trip.id, today, stage === "upcoming" ? null : next.ends_at));
  }
  await db.batch(statements);

  return { ...trip, ...next };
}

// ---------- Reveal (admin) ----------

/** Reveals now. Returns the revealed trip and, the first time, the "revealed" push to send after the response. */
export async function revealTrip(env: Env, trip: TripRow, actorId: string): Promise<{ trip: TripRow; notify: AfterResponse }> {
  const now = Date.now();
  // Claim the notice and write revealed_at in one batch (a transaction), claim first: a cron run can never see
  // the trip revealed but unclaimed and notify the admin about their own reveal. Sent after the response.
  const [claim] = await env.DB.batch([repo.claimRevealedNotice(env.DB, trip.id, now), repo.markRevealed(env.DB, trip.id, now)]);
  return {
    trip: { ...trip, revealed_at: trip.revealed_at ?? now },
    notify: claim!.meta.changes > 0 ? () => sendTripRevealed(env, trip, actorId) : null,
  };
}

// ---------- Delete (creator) ----------

/** Deletes the rollo for everyone: rows go in one batch, its R2 files are queued for the cron purge. */
export async function deleteTrip(db: D1Database, trip: TripRow): Promise<void> {
  await db.batch(repo.deleteTripStatements(db, trip.id, Date.now()));
}
