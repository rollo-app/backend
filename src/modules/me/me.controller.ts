import type { RouteHandler } from "@hono/zod-openapi";
import { isRevealed, publicUser } from "../../lib/util";
import type { AppEnv } from "../../types";
import type {
  avatarCompleteRoute,
  avatarRoute,
  deleteMeRoute,
  deletePushTokenRoute,
  getMeRoute,
  getSettingsRoute,
  myTripsRoute,
  putPushTokenRoute,
  updateMeRoute,
  updateSettingsRoute,
} from "./me.router";
import * as service from "./me.service";

export const getMe: RouteHandler<typeof getMeRoute, AppEnv> = async (c) => c.json(publicUser(c.get("user")), 200);

export const updateMe: RouteHandler<typeof updateMeRoute, AppEnv> = async (c) => {
  const user = await service.updateProfile(c.get("deps").db, c.get("user"), c.req.valid("json"));
  return c.json(publicUser(user), 200);
};

export const requestAvatar: RouteHandler<typeof avatarRoute, AppEnv> = async (c) => {
  const { sizeBytes } = c.req.valid("json");
  return c.json(await service.requestAvatarUpload(c.get("deps"), new URL(c.req.url).origin, c.get("user"), sizeBytes), 200);
};

export const completeAvatar: RouteHandler<typeof avatarCompleteRoute, AppEnv> = async (c) => {
  const user = await service.completeAvatarUpload(c.get("deps"), c.get("user"));
  return c.json(publicUser(user), 200);
};

export const deleteMe: RouteHandler<typeof deleteMeRoute, AppEnv> = async (c) => {
  await service.removeAccount(c.get("deps"), c.get("user"));
  return c.body(null, 204);
};

export const myTrips: RouteHandler<typeof myTripsRoute, AppEnv> = async (c) => {
  const now = Date.now();
  const rows = await service.listMyTrips(c.get("deps").db, c.get("user").id);
  return c.json(
    {
      trips: rows.map((t) => ({
        id: t.id,
        name: t.name,
        joinCode: t.join_code,
        startsAt: t.starts_at,
        endsAt: t.ends_at,
        revealAt: t.reveal_at,
        revealed: isRevealed(t, now),
        role: t.my_role,
        totalUploaded: t.total_uploaded,
        coverThumbhash: t.cover_thumbhash,
      })),
    },
    200,
  );
};

export const putPushToken: RouteHandler<typeof putPushTokenRoute, AppEnv> = async (c) => {
  const { token } = c.req.valid("param");
  await service.registerPushToken(c.get("deps").db, c.get("user").id, c.get("sessionId"), token);
  return c.body(null, 204);
};

export const deletePushToken: RouteHandler<typeof deletePushTokenRoute, AppEnv> = async (c) => {
  const { token } = c.req.valid("param");
  await service.unregisterPushToken(c.get("deps").db, c.get("user").id, token);
  return c.body(null, 204);
};

export const getSettings: RouteHandler<typeof getSettingsRoute, AppEnv> = async (c) => {
  const notifications = await service.getSettings(c.get("deps").db, c.get("user").id);
  return c.json({ notifications }, 200);
};

export const updateSettings: RouteHandler<typeof updateSettingsRoute, AppEnv> = async (c) => {
  const body = c.req.valid("json");
  const notifications = await service.updateSettings(c.get("deps").db, c.get("user").id, body.notifications ?? {});
  return c.json({ notifications }, 200);
};
