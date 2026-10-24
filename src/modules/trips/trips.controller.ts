import type { RouteHandler } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { deferPush } from "../../lib/push";
import { publicMember, publicTrip } from "../../lib/util";
import type { AppEnv } from "../../types";
import type {
  addMembersRoute,
  createTripRoute,
  getTripRoute,
  joinTripRoute,
  leaveRoute,
  removeMemberRoute,
  revealRoute,
  updateTripRoute,
} from "./trips.router";
import * as service from "./trips.service";

export const create: RouteHandler<typeof createTripRoute, AppEnv> = async (c) => {
  const user = c.get("user");
  const created = await service.createTrip(c.env.DB, user, c.req.valid("json"));
  // No kind in `src/shared/errors.ts` for a 500, so this one stays an HTTPException.
  if (!created) throw new HTTPException(500, { message: "No se pudo generar un código" });
  return c.json({ trip: publicTrip(created.trip, Date.now()), member: publicMember(created.member, user) }, 201);
};

export const join: RouteHandler<typeof joinTripRoute, AppEnv> = async (c) => {
  const user = c.get("user");
  const { created, trip, member } = await service.joinTrip(c.env.DB, user, c.req.valid("json").code);
  const body = { trip: publicTrip(trip, Date.now()), member: publicMember(member, user) };
  if (created) return c.json(body, 201);
  return c.json(body, 200);
};

export const detail: RouteHandler<typeof getTripRoute, AppEnv> = async (c) => {
  const trip = c.get("trip");
  const user = c.get("user");
  const { members, blocked, today, totalUploaded } = await service.getTripDetail(c.env.DB, trip, c.get("member"), user.id);
  return c.json(
    {
      trip: publicTrip(trip, Date.now()),
      me: publicMember(c.get("member"), user),
      members: members.map((m) => publicMember(m, m, blocked.has(m.user_id))),
      today,
      totalUploaded,
    },
    200,
  );
};

export const update: RouteHandler<typeof updateTripRoute, AppEnv> = async (c) => {
  const trip = await service.updateTrip(c.env.DB, c.get("trip"), c.req.valid("json"));
  return c.json({ trip: publicTrip(trip) }, 200);
};

export const reveal: RouteHandler<typeof revealRoute, AppEnv> = async (c) => {
  const { trip, notify } = await service.revealTrip(c.env, c.get("trip"), c.get("user").id);
  if (notify) deferPush(c, notify());
  return c.json({ trip: publicTrip(trip, Date.now()) }, 200);
};

export const addMembers: RouteHandler<typeof addMembersRoute, AppEnv> = async (c) => {
  const { results, notify } = await service.addFriendsToTrip(
    c.env,
    c.get("trip"),
    c.get("user"),
    c.get("member").role,
    c.req.valid("json").friendIds,
  );
  if (notify) deferPush(c, notify());
  return c.json({ results }, 200);
};

export const leave: RouteHandler<typeof leaveRoute, AppEnv> = async (c) => {
  await service.leaveTrip(c.env.DB, c.get("member"));
  return c.body(null, 204);
};

export const removeMember: RouteHandler<typeof removeMemberRoute, AppEnv> = async (c) => {
  await service.removeMember(c.env.DB, c.get("trip"), c.get("member"), c.req.valid("param").memberId);
  return c.body(null, 204);
};
