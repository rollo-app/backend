import type { RouteHandler } from "@hono/zod-openapi";
import { deferPush } from "../../lib/push";
import { avatarUrl } from "../../lib/util";
import type { AppEnv } from "../../types";
import type { PublicFriendRow } from "../friends/friends.repository";
import type { acceptRoute, cancelRoute, listRoute, rejectRoute, sendRoute } from "./friend-requests.router";
import * as service from "./friend-requests.service";

const publicFriend = (u: PublicFriendRow) => ({
  id: u.id,
  name: u.name ?? "",
  username: u.username,
  avatarUrl: avatarUrl(u.id, u.avatar_key),
  bio: u.bio,
});

export const send: RouteHandler<typeof sendRoute, AppEnv> = async (c) => {
  const { status, notify } = await service.sendRequest(c.env, c.get("user"), c.req.valid("param").userId);
  if (notify) deferPush(c, notify());
  return c.json({ status }, 200);
};

export const cancel: RouteHandler<typeof cancelRoute, AppEnv> = async (c) => {
  await service.cancelRequest(c.env.DB, c.get("user").id, c.req.valid("param").userId);
  return c.body(null, 204);
};

export const list: RouteHandler<typeof listRoute, AppEnv> = async (c) => {
  const rows = await service.listReceived(c.env.DB, c.get("user").id);
  return c.json({ requests: rows.map((r) => ({ user: publicFriend(r), createdAt: r.requested_at })) }, 200);
};

export const accept: RouteHandler<typeof acceptRoute, AppEnv> = async (c) => {
  const { friend, notify } = await service.acceptRequest(c.env, c.get("user"), c.req.valid("param").userId);
  if (notify) deferPush(c, notify());
  return c.json({ friend: publicFriend(friend) }, 200);
};

export const reject: RouteHandler<typeof rejectRoute, AppEnv> = async (c) => {
  await service.rejectRequest(c.env.DB, c.get("user").id, c.req.valid("param").userId);
  return c.body(null, 204);
};
