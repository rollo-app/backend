import type { RouteHandler } from "@hono/zod-openapi";
import { deferPush } from "../../lib/push";
import { avatarUrl } from "../../lib/util";
import type { AppEnv } from "../../types";
import type { PublicFriendRow } from "./friends.repository";
import type { claimRoute, linkRoute, listRoute, profileRoute, redeemRoute, removeRoute } from "./friends.router";
import * as service from "./friends.service";

const publicFriend = (u: PublicFriendRow) => ({
  id: u.id,
  name: u.name ?? "",
  username: u.username,
  avatarUrl: avatarUrl(u.id, u.avatar_key),
  bio: u.bio,
});

export const link: RouteHandler<typeof linkRoute, AppEnv> = async (c) => {
  return c.json(await service.generateLink(c.env.DB, c.get("user").id), 200);
};

export const claim: RouteHandler<typeof claimRoute, AppEnv> = async (c) => {
  const { claimToken, expiresAt, creator } = await service.claimLink(
    c.env.DB,
    c.req.header("cf-connecting-ip"),
    c.req.valid("json").code,
  );
  return c.json(
    { claimToken, expiresAt, creator: { name: creator.name ?? "", username: creator.username, avatarUrl: avatarUrl(creator.user_id, creator.avatar_key) } },
    200,
  );
};

export const redeem: RouteHandler<typeof redeemRoute, AppEnv> = async (c) => {
  const me = c.get("user");
  const { friend, notify } = await service.redeem(c.env, me, c.req.header("cf-connecting-ip"), c.req.valid("json"));
  if (notify) deferPush(c, notify());
  return c.json({ friend: publicFriend(friend) }, 200);
};

export const list: RouteHandler<typeof listRoute, AppEnv> = async (c) => {
  const friends = await service.listFriends(c.env.DB, c.get("user").id);
  return c.json({ friends: friends.map(publicFriend) }, 200);
};

export const profile: RouteHandler<typeof profileRoute, AppEnv> = async (c) => {
  const { friend, commonTrips } = await service.getFriendProfile(c.env.DB, c.get("user").id, c.req.valid("param").userId);
  return c.json(
    {
      friend: publicFriend(friend),
      commonTrips: commonTrips.map(({ trip: t, revealed }) => ({
        id: t.id,
        name: t.name,
        startsAt: t.starts_at,
        endsAt: t.ends_at,
        revealed,
      })),
    },
    200,
  );
};

export const remove: RouteHandler<typeof removeRoute, AppEnv> = async (c) => {
  await service.removeFriend(c.env.DB, c.get("user").id, c.req.valid("param").userId);
  return c.body(null, 204);
};
