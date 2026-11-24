import type { RouteHandler } from "@hono/zod-openapi";
import type { AppEnv } from "../../types";
import { deferPush } from "../../lib/push";
import { serveMediaFile } from "../../lib/r2";
import type { addFinalistRoute, finalistFileRoute, getContestRoute, pickWinnerRoute, removeFinalistRoute, unvoteRoute, voteRoute } from "./contest.router";
import * as service from "./contest.service";

export const get: RouteHandler<typeof getContestRoute, AppEnv> = async (c) => {
  return c.json(await service.getContest(c.env.DB, c.get("trip"), c.get("member"), c.get("user").id), 200);
};

export const add: RouteHandler<typeof addFinalistRoute, AppEnv> = async (c) => {
  const { mediaId } = c.req.valid("param");
  await service.addFinalist(c.env.DB, c.get("trip"), c.get("member"), mediaId);
  return c.body(null, 204);
};

export const remove: RouteHandler<typeof removeFinalistRoute, AppEnv> = async (c) => {
  const { mediaId } = c.req.valid("param");
  await service.removeFinalist(c.env.DB, c.get("trip"), c.get("member"), mediaId);
  return c.body(null, 204);
};

export const vote: RouteHandler<typeof voteRoute, AppEnv> = async (c) => {
  const { mediaId } = c.req.valid("json");
  await service.castVote(c.env.DB, c.get("trip"), c.get("user").id, mediaId);
  return c.body(null, 204);
};

export const unvote: RouteHandler<typeof unvoteRoute, AppEnv> = async (c) => {
  await service.removeVote(c.env.DB, c.get("trip"), c.get("user").id);
  return c.body(null, 204);
};

export const finalistFile: RouteHandler<typeof finalistFileRoute, AppEnv> = async (c) => {
  const { mediaId, variant } = c.req.valid("param");
  const { key, fallbackKey } = await service.getFinalistFileKey(c.env.DB, c.get("trip"), c.get("member"), c.get("user").id, mediaId, variant);
  return serveMediaFile(c.env.MEDIA, key, fallbackKey, c.req.raw.headers);
};

export const pickWinner: RouteHandler<typeof pickWinnerRoute, AppEnv> = async (c) => {
  const { mediaId } = c.req.valid("json");
  const { notify } = await service.pickWinner(c.env, c.get("trip"), mediaId);
  if (notify) deferPush(c, notify());
  return c.body(null, 204);
};
