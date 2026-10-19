import { createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { generateToken, hashToken, requireAdmin, requireMember } from "../lib/auth";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { generateJoinCode, isRevealed, localDate, publicTrip } from "../lib/util";
import {
  CreateTripSchema,
  JoinTripSchema,
  MemberSchema,
  TripCreatedSchema,
  TripDetailSchema,
  TripMemberParams,
  TripParams,
  TripResponseSchema,
  UpdateMeSchema,
  UpdateTripSchema,
  PAST_TOLERANCE_MS,
} from "../schemas";
import type { Role, TripRow } from "../types";

const trips = createApp();
const tags = ["Trips"];

// ---------- Create ----------

const createTripRoute = createRoute({
  method: "post",
  path: "/",
  tags,
  summary: "Create a trip",
  description: "Whoever creates it becomes the admin. Returns the invite code and the admin token.",
  request: { body: { content: { "application/json": { schema: CreateTripSchema } }, required: true } },
  responses: { 201: json(TripCreatedSchema, "Trip created"), ...errors(400) },
});

trips.openapi(createTripRoute, async (c) => {
  const body = c.req.valid("json");
  const now = Date.now();

  // Unique code (collisions are very unlikely, but we retry just in case).
  let joinCode = "";
  for (let i = 0; i < 5 && !joinCode; i++) {
    const candidate = generateJoinCode();
    const taken = await c.env.DB.prepare("SELECT 1 FROM trips WHERE join_code = ?").bind(candidate).first();
    if (!taken) joinCode = candidate;
  }
  if (!joinCode) throw new HTTPException(500, { message: "No se pudo generar un código" });

  const tripId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const token = generateToken();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO trips (id, name, join_code, timezone, starts_at, ends_at, reveal_at,
                          daily_photo_limit, daily_video_limit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      tripId, body.name, joinCode, body.timezone, body.startsAt, body.endsAt, body.revealAt,
      body.dailyPhotoLimit, body.dailyVideoLimit, now,
    ),
    c.env.DB.prepare(
      `INSERT INTO members (id, trip_id, name, role, token_hash, created_at)
       VALUES (?, ?, ?, 'admin', ?, ?)`,
    ).bind(memberId, tripId, body.adminName, await hashToken(token), now),
  ]);

  const trip = await c.env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(tripId).first<TripRow>();
  return c.json(
    { trip: publicTrip(trip!, now), member: { id: memberId, name: body.adminName, role: "admin" as Role }, token },
    201,
  );
});

// ---------- Join ----------

const joinTripRoute = createRoute({
  method: "post",
  path: "/join",
  tags,
  summary: "Join a trip",
  description: "With the code and a name. The name is unique per trip (case-insensitive).",
  request: { body: { content: { "application/json": { schema: JoinTripSchema } }, required: true } },
  responses: { 201: json(TripCreatedSchema, "Joined the trip"), ...errors(400, 404, 409) },
});

trips.openapi(joinTripRoute, async (c) => {
  const { code, name: memberName } = c.req.valid("json");
  const now = Date.now();

  const trip = await c.env.DB.prepare("SELECT * FROM trips WHERE join_code = ?").bind(code).first<TripRow>();
  if (!trip) throw new HTTPException(404, { message: "Código inválido" });
  if (publicTrip(trip, now).revealed) throw new HTTPException(409, { message: "Este rollo ya se reveló" });

  const taken = await c.env.DB.prepare(
    "SELECT 1 FROM members WHERE trip_id = ? AND name = ? AND removed_at IS NULL",
  ).bind(trip.id, memberName).first();
  if (taken) throw new HTTPException(409, { message: "Ya hay alguien con ese nombre en el rollo" });

  const memberId = crypto.randomUUID();
  const token = generateToken();
  await c.env.DB.prepare(
    `INSERT INTO members (id, trip_id, name, role, token_hash, created_at)
     VALUES (?, ?, ?, 'member', ?, ?)`,
  ).bind(memberId, trip.id, memberName, await hashToken(token), now).run();

  return c.json(
    { trip: publicTrip(trip, now), member: { id: memberId, name: memberName, role: "member" as Role }, token },
    201,
  );
});

// ---------- Detail ----------

const getTripRoute = createRoute({
  method: "get",
  path: "/{tripId}",
  tags,
  summary: "Trip info",
  description: "Trip, members and how many photos and videos you have left today.",
  security: bearerAuth,
  middleware: [requireMember] as const,
  request: { params: TripParams },
  responses: { 200: json(TripDetailSchema, "Trip detail"), ...errors(401, 403) },
});

trips.openapi(getTripRoute, async (c) => {
  const trip = c.get("trip");
  const me = c.get("member");
  const now = Date.now();
  const today = localDate(now, trip.timezone);

  const [members, usage, totals] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id, name, role FROM members WHERE trip_id = ? AND removed_at IS NULL ORDER BY created_at",
    ).bind(trip.id).all<{ id: string; name: string; role: Role }>(),
    c.env.DB.prepare(
      `SELECT type, COUNT(*) AS n FROM media
       WHERE member_id = ? AND local_date = ? GROUP BY type`,
    ).bind(me.id, today).all<{ type: string; n: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM media WHERE trip_id = ? AND status = 'uploaded' AND deleted_at IS NULL`,
    ).bind(trip.id).first<{ n: number }>(),
  ]);

  // Outside the rollo's dates (or once revealed) nothing can be shot.
  const active = now >= trip.starts_at && now <= trip.ends_at && !isRevealed(trip, now);
  const used = (type: string) => usage.results.find((r) => r.type === type)?.n ?? 0;

  return c.json(
    {
      trip: publicTrip(trip, now),
      me: { id: me.id, name: me.name, role: me.role },
      members: members.results,
      today: {
        date: today,
        photosLeft: !active ? 0 : Math.max(0, trip.daily_photo_limit - used("photo")),
        videosLeft: !active ? 0 : Math.max(0, trip.daily_video_limit - used("video")),
      },
      totalUploaded: totals?.n ?? 0,
    },
    200,
  );
});

// ---------- Edit (admin) ----------

const updateTripRoute = createRoute({
  method: "patch",
  path: "/{tripId}",
  tags,
  summary: "Edit the trip (admin)",
  security: bearerAuth,
  middleware: [requireMember, requireAdmin] as const,
  request: {
    params: TripParams,
    body: { content: { "application/json": { schema: UpdateTripSchema } }, required: true },
  },
  responses: { 200: json(TripResponseSchema, "Trip updated"), ...errors(400, 401, 403) },
});

trips.openapi(updateTripRoute, async (c) => {
  const trip = c.get("trip");
  const b = c.req.valid("json");
  // Only the fields being changed are checked, so a trip that already started can still be edited.
  const earliest = Date.now() - PAST_TOLERANCE_MS;
  if (b.endsAt !== undefined && b.endsAt < earliest) throw new HTTPException(400, { message: "El fin no puede ser en el pasado" });
  if (b.revealAt !== undefined && b.revealAt < earliest) throw new HTTPException(400, { message: "El revelado no puede ser en el pasado" });
  const next = {
    name: b.name ?? trip.name,
    ends_at: b.endsAt ?? trip.ends_at,
    reveal_at: b.revealAt ?? trip.reveal_at,
    daily_photo_limit: b.dailyPhotoLimit ?? trip.daily_photo_limit,
    daily_video_limit: b.dailyVideoLimit ?? trip.daily_video_limit,
  };
  if (next.ends_at <= trip.starts_at) throw new HTTPException(400, { message: "El rollo tiene que terminar después de empezar" });
  if (next.reveal_at < next.ends_at) throw new HTTPException(400, { message: "El revelado no puede ser antes del fin" });

  await c.env.DB.prepare(
    `UPDATE trips SET name = ?, ends_at = ?, reveal_at = ?, daily_photo_limit = ?, daily_video_limit = ?
     WHERE id = ?`,
  ).bind(next.name, next.ends_at, next.reveal_at, next.daily_photo_limit, next.daily_video_limit, trip.id).run();

  return c.json({ trip: publicTrip({ ...trip, ...next }) }, 200);
});

// ---------- Reveal (admin) ----------

const revealRoute = createRoute({
  method: "post",
  path: "/{tripId}/reveal",
  tags,
  summary: "Reveal the roll now (admin)",
  security: bearerAuth,
  middleware: [requireMember, requireAdmin] as const,
  request: { params: TripParams },
  responses: { 200: json(TripResponseSchema, "Roll revealed"), ...errors(401, 403) },
});

trips.openapi(revealRoute, async (c) => {
  const trip = c.get("trip");
  const now = Date.now();
  if (trip.revealed_at === null) {
    await c.env.DB.prepare("UPDATE trips SET revealed_at = ? WHERE id = ?").bind(now, trip.id).run();
  }
  return c.json({ trip: publicTrip({ ...trip, revealed_at: trip.revealed_at ?? now }, now) }, 200);
});

// ---------- Edit my name ----------

const updateMeRoute = createRoute({
  method: "patch",
  path: "/{tripId}/members/me",
  tags,
  summary: "Change your name in the trip",
  description: "Same rules as when joining: unique per trip, case-insensitive.",
  security: bearerAuth,
  middleware: [requireMember] as const,
  request: {
    params: TripParams,
    body: { content: { "application/json": { schema: UpdateMeSchema } }, required: true },
  },
  responses: { 200: json(MemberSchema, "Name updated"), ...errors(400, 401, 403, 409) },
});

trips.openapi(updateMeRoute, async (c) => {
  const me = c.get("member");
  const { name } = c.req.valid("json");

  const taken = await c.env.DB.prepare(
    "SELECT 1 FROM members WHERE trip_id = ? AND name = ? AND id != ? AND removed_at IS NULL",
  ).bind(me.trip_id, name, me.id).first();
  if (taken) throw new HTTPException(409, { message: "Ya hay alguien con ese nombre en el rollo" });

  await c.env.DB.prepare("UPDATE members SET name = ? WHERE id = ?").bind(name, me.id).run();
  return c.json({ id: me.id, name, role: me.role }, 200);
});

// ---------- Remove member (admin) ----------

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{tripId}/members/{memberId}",
  tags,
  summary: "Remove someone from the trip (admin)",
  description: "Their token stops working and their name is freed. Their photos stay in the roll.",
  security: bearerAuth,
  middleware: [requireMember, requireAdmin] as const,
  request: { params: TripMemberParams },
  responses: { 204: { description: "Member removed" }, ...errors(400, 401, 403, 404) },
});

trips.openapi(removeMemberRoute, async (c) => {
  const { memberId } = c.req.valid("param");
  if (memberId === c.get("member").id) {
    throw new HTTPException(400, { message: "No te podés sacar a vos mismo" });
  }
  const res = await c.env.DB.prepare(
    "UPDATE members SET removed_at = ? WHERE id = ? AND trip_id = ? AND removed_at IS NULL",
  ).bind(Date.now(), memberId, c.get("trip").id).run();
  if (!res.meta.changes) throw new HTTPException(404, { message: "Miembro no encontrado" });
  return c.body(null, 204);
});

export default trips;
