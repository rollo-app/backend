import type { RouteHandler } from "@hono/zod-openapi";
import { avatarUrl, toBadge } from "../../lib/util";
import type { AppEnv } from "../../types";
import type { friendsRoute, profileRoute } from "./users.router";
import * as service from "./users.service";

export const profile: RouteHandler<typeof profileRoute, AppEnv> = async (c) => {
  const { owner, isFriend, blockedByMe, reportedByMe, canSee, friendCount, mutualCount } = await service.getProfile(
    c.get("deps").db,
    c.get("user").id,
    c.req.valid("param").userId,
  );
  return c.json(
    {
      user: {
        id: owner.id,
        name: owner.name ?? "",
        username: owner.username,
        avatarUrl: avatarUrl(owner.id, owner.avatar_key),
        bio: owner.bio,
        badge: toBadge(owner.badge),
      },
      isFriend,
      blockedByMe,
      reportedByMe,
      profileVisibility: owner.profile_visibility,
      canSee,
      friendCount,
      mutualCount,
    },
    200,
  );
};

export const friends: RouteHandler<typeof friendsRoute, AppEnv> = async (c) => {
  const { scope, friends } = await service.listFriends(c.get("deps").db, c.get("user").id, c.req.valid("param").userId);
  return c.json(
    {
      scope,
      friends: friends.map((u) => ({ id: u.id, name: u.name ?? "", username: u.username, avatarUrl: avatarUrl(u.id, u.avatar_key) })),
    },
    200,
  );
};
