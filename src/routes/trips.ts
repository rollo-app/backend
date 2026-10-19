import { createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { generateToken, hashToken, requireAdmin, requireMember } from "../lib/auth";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { generateJoinCode, localDate, publicTrip } from "../lib/util";
import {
  CreateTripSchema,
  JoinTripSchema,
  TripCreatedSchema,
  TripDetailSchema,
  TripMemberParams,
  TripParams,
  TripResponseSchema,
  UpdateTripSchema,
} from "../schemas";
import type { Role, TripRow } from "../types";

const trips = createApp();
const tags = ["Viajes"];

// ---------- Crear ----------

const createTripRoute = createRoute({
  method: "post",
  path: "/",
  tags,
  summary: "Crear un viaje",
  description: "Quien lo crea queda como admin. Devuelve el código para invitar y el token del admin.",
  request: { body: { content: { "application/json": { schema: CreateTripSchema } }, required: true } },
  responses: { 201: json(TripCreatedSchema, "Viaje creado"), ...errors(400) },
});

trips.openapi(createTripRoute, async (c) => {
  const body = c.req.valid("json");
  const now = Date.now();

  // Código único (colisiones muy improbables, pero reintentamos por las dudas).
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

// ---------- Unirse ----------

const joinTripRoute = createRoute({
  method: "post",
  path: "/join",
  tags,
  summary: "Unirse a un viaje",
  description: "Con el código y un nombre. El nombre es único por viaje (sin distinguir mayúsculas).",
  request: { body: { content: { "application/json": { schema: JoinTripSchema } }, required: true } },
  responses: { 201: json(TripCreatedSchema, "Te uniste al viaje"), ...errors(400, 404, 409) },
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
  if (taken) throw new HTTPException(409, { message: "Ya hay alguien con ese nombre en el viaje" });

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

// ---------- Detalle ----------

const getTripRoute = createRoute({
  method: "get",
  path: "/{tripId}",
  tags,
  summary: "Info del viaje",
  description: "Viaje, miembros y cuántas fotos y videos te quedan hoy.",
  security: bearerAuth,
  middleware: [requireMember] as const,
  request: { params: TripParams },
  responses: { 200: json(TripDetailSchema, "Detalle del viaje"), ...errors(401, 403) },
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
      `SELECT COUNT(*) AS n FROM media WHERE trip_id = ? AND status = 'uploaded'`,
    ).bind(trip.id).first<{ n: number }>(),
  ]);

  const used = (type: string) => usage.results.find((r) => r.type === type)?.n ?? 0;

  return c.json(
    {
      trip: publicTrip(trip, now),
      me: { id: me.id, name: me.name, role: me.role },
      members: members.results,
      today: {
        date: today,
        photosLeft: Math.max(0, trip.daily_photo_limit - used("photo")),
        videosLeft: Math.max(0, trip.daily_video_limit - used("video")),
      },
      totalUploaded: totals?.n ?? 0,
    },
    200,
  );
});

// ---------- Editar (admin) ----------

const updateTripRoute = createRoute({
  method: "patch",
  path: "/{tripId}",
  tags,
  summary: "Editar el viaje (admin)",
  security: bearerAuth,
  middleware: [requireMember, requireAdmin] as const,
  request: {
    params: TripParams,
    body: { content: { "application/json": { schema: UpdateTripSchema } }, required: true },
  },
  responses: { 200: json(TripResponseSchema, "Viaje actualizado"), ...errors(400, 401, 403) },
});

trips.openapi(updateTripRoute, async (c) => {
  const trip = c.get("trip");
  const b = c.req.valid("json");
  const next = {
    name: b.name ?? trip.name,
    ends_at: b.endsAt ?? trip.ends_at,
    reveal_at: b.revealAt ?? trip.reveal_at,
    daily_photo_limit: b.dailyPhotoLimit ?? trip.daily_photo_limit,
    daily_video_limit: b.dailyVideoLimit ?? trip.daily_video_limit,
  };
  if (next.ends_at <= trip.starts_at) throw new HTTPException(400, { message: "endsAt inválido" });

  await c.env.DB.prepare(
    `UPDATE trips SET name = ?, ends_at = ?, reveal_at = ?, daily_photo_limit = ?, daily_video_limit = ?
     WHERE id = ?`,
  ).bind(next.name, next.ends_at, next.reveal_at, next.daily_photo_limit, next.daily_video_limit, trip.id).run();

  return c.json({ trip: publicTrip({ ...trip, ...next }) }, 200);
});

// ---------- Revelar (admin) ----------

const revealRoute = createRoute({
  method: "post",
  path: "/{tripId}/reveal",
  tags,
  summary: "Revelar el rollo ya (admin)",
  security: bearerAuth,
  middleware: [requireMember, requireAdmin] as const,
  request: { params: TripParams },
  responses: { 200: json(TripResponseSchema, "Rollo revelado"), ...errors(401, 403) },
});

trips.openapi(revealRoute, async (c) => {
  const trip = c.get("trip");
  const now = Date.now();
  if (trip.revealed_at === null) {
    await c.env.DB.prepare("UPDATE trips SET revealed_at = ? WHERE id = ?").bind(now, trip.id).run();
  }
  return c.json({ trip: publicTrip({ ...trip, revealed_at: trip.revealed_at ?? now }, now) }, 200);
});

// ---------- Sacar miembro (admin) ----------

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{tripId}/members/{memberId}",
  tags,
  summary: "Sacar a alguien del viaje (admin)",
  description: "Su token deja de servir y su nombre queda libre. Sus fotos quedan en el rollo.",
  security: bearerAuth,
  middleware: [requireMember, requireAdmin] as const,
  request: { params: TripMemberParams },
  responses: { 204: { description: "Miembro removido" }, ...errors(400, 401, 403, 404) },
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
