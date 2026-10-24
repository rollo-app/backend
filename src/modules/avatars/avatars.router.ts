import { createRoute, z } from "@hono/zod-openapi";
import { createApp, errors } from "../../lib/openapi";
import * as controller from "./avatars.controller";
import { AvatarParams } from "./avatars.schemas";

export const getAvatarRoute = createRoute({
  method: "get",
  path: "/{userId}/{file}",
  tags: ["Profile"],
  summary: "Download a user's avatar",
  description:
    "Public (no token) so it can be used directly as an image URL. Only the user's current avatar is served; " +
    "file names are random, so older or guessed ones return 404.",
  request: { params: AvatarParams },
  responses: {
    200: { description: "Avatar", content: { "image/jpeg": { schema: z.string().openapi({ format: "binary" }) } } },
    ...errors(404),
  },
});

const avatars = createApp();

avatars.openapi(getAvatarRoute, controller.getAvatar);

export default avatars;
