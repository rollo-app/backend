import type { RouteHandler } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { isCreator } from "../../lib/creator";
import { deferPush } from "../../lib/push";
import { publicMember, publicTrip } from "../../lib/util";
import type { AppEnv } from "../../types";
import type {
  addMembersRoute,
  createTripRoute,
  deleteTripRoute,
  getTripRoute,
  joinTripRoute,
  leaveRoute,
  makeAdminRoute,
  removeAdminRoute,
  removeMemberRoute,
  revealRoute,
  updateMyMembershipRoute,
  updateTripRoute,
} from "./trips.router";
import * as members from "./members.service";
import * as service from "./trips.service";

export const create: RouteHandler<typeof createTripRoute, AppEnv> = async (c) => {
  const user = c.get("user");
  const created = await service.createTrip(c.env.DB, user, c.req.valid("json"));
  // No kind in `src/shared/errors.ts` for a 500, so this one stays an HTTPException.
  if (!created) throw new HTTPException(500, { message: "No se pudo generar un código" });
  const createdBy = { userId: user.id, name: user.name ?? "" };
  return c.json({ trip: publicTrip(created.trip, Date.now(), createdBy), member: publicMember(created.member, user, false, true) }, 201);
};

export const join: RouteHandler<typeof joinTripRoute, AppEnv> = async (c) => {
  const user = c.get("user");
  const { created, trip, member } = await members.joinTrip(c.env.DB, user, c.req.valid("json").code);
  const createdBy = await service.getCreator(c.env.DB, trip);
  const body = { trip: publicTrip(trip, Date.now(), createdBy), member: publicMember(member, user, false, isCreator(trip, user.id)) };
  if (created) return c.json(body, 201);
  return c.json(body, 200);
};

export const detail: RouteHandler<typeof getTripRoute, AppEnv> = async (c) => {
  const trip = c.get("trip");
  const user = c.get("user");
  const { members, blocked, today, totalUploaded } = await service.getTripDetail(c.env.DB, trip, c.get("member"), user.id);
  const createdBy = await service.getCreator(c.env.DB, trip);
  return c.json(
    {
      trip: publicTrip(trip, Date.now(), createdBy),
      me: { ...publicMember(c.get("member"), user, false, isCreator(trip, user.id)), allowFeaturing: c.get("member").allow_featuring !== 0 },
      members: members.map((m) => publicMember(m, m, blocked.has(m.user_id), isCreator(trip, m.user_id))),
      today,
      totalUploaded,
    },
    200,
  );
};

export const update: RouteHandler<typeof updateTripRoute, AppEnv> = async (c) => {
  const trip = await service.updateTrip(c.env.DB, c.get("trip"), c.get("user").id, c.req.valid("json"));
  return c.json({ trip: publicTrip(trip, Date.now(), await service.getCreator(c.env.DB, trip)) }, 200);
};

export const reveal: RouteHandler<typeof revealRoute, AppEnv> = async (c) => {
  const { trip, notify } = await service.revealTrip(c.env, c.get("trip"), c.get("user").id);
  if (notify) deferPush(c, notify());
  return c.json({ trip: publicTrip(trip, Date.now(), await service.getCreator(c.env.DB, trip)) }, 200);
};

export const addMembers: RouteHandler<typeof addMembersRoute, AppEnv> = async (c) => {
  const { results, notify } = await members.addFriendsToTrip(
    c.env,
    c.get("trip"),
    c.get("user"),
    c.get("member").role,
    c.req.valid("json").friendIds,
  );
  if (notify) deferPush(c, notify());
  return c.json({ results }, 200);
};

export const updateMyMembership: RouteHandler<typeof updateMyMembershipRoute, AppEnv> = async (c) => {
  const mine = await members.updateMyMembership(c.env.DB, c.get("trip"), c.get("member"), c.req.valid("json"));
  return c.json(mine, 200);
};

export const leave: RouteHandler<typeof leaveRoute, AppEnv> = async (c) => {
  await members.leaveTrip(c.env.DB, c.get("trip"), c.get("member"));
  return c.body(null, 204);
};

export const removeMember: RouteHandler<typeof removeMemberRoute, AppEnv> = async (c) => {
  await members.removeMember(c.env.DB, c.get("trip"), c.get("member"), c.req.valid("param").memberId);
  return c.body(null, 204);
};

export const makeAdmin: RouteHandler<typeof makeAdminRoute, AppEnv> = async (c) => {
  const trip = c.get("trip");
  const target = await members.makeAdmin(c.env.DB, trip, c.req.valid("param").memberId);
  return c.json(await members.memberView(c.env.DB, trip, c.get("user").id, target), 200);
};

export const removeAdmin: RouteHandler<typeof removeAdminRoute, AppEnv> = async (c) => {
  const trip = c.get("trip");
  const target = await members.removeAdmin(c.env.DB, trip, c.req.valid("param").memberId);
  return c.json(await members.memberView(c.env.DB, trip, c.get("user").id, target), 200);
};

export const remove: RouteHandler<typeof deleteTripRoute, AppEnv> = async (c) => {
  await service.deleteTrip(c.env.DB, c.get("trip"));
  return c.body(null, 204);
};
