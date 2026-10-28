import type { RouteHandler } from "@hono/zod-openapi";
import { deferPush } from "../../lib/push";
import type { AppEnv } from "../../types";
import type { createCommentRoute, deleteCommentRoute, listCommentsRoute, myCommentsRoute } from "./comments.router";
import { DEFAULT_MY_COMMENTS_PAGE } from "./comments.schemas";
import * as service from "./comments.service";

export const list: RouteHandler<typeof listCommentsRoute, AppEnv> = async (c) => {
  const comments = await service.listComments(c.env.DB, c.get("user").id, c.req.valid("param").mediaId);
  return c.json({ comments }, 200);
};

export const create: RouteHandler<typeof createCommentRoute, AppEnv> = async (c) => {
  const { comment, notify } = await service.createComment(c.env, c.get("user"), c.req.valid("param").mediaId, c.req.valid("json").text);
  if (notify) deferPush(c, notify());
  return c.json(comment, 201);
};

export const remove: RouteHandler<typeof deleteCommentRoute, AppEnv> = async (c) => {
  await service.deleteComment(c.env.DB, c.get("user").id, c.req.valid("param").commentId);
  return c.body(null, 204);
};

export const myComments: RouteHandler<typeof myCommentsRoute, AppEnv> = async (c) => {
  const { cursor, limit } = c.req.valid("query");
  return c.json(await service.listMyComments(c.env.DB, c.get("user").id, { cursor, limit: limit ?? DEFAULT_MY_COMMENTS_PAGE }), 200);
};
