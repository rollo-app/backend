import { createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { createApp, errors } from "../lib/openapi";
import { AvatarParams } from "../schemas";

const avatars = createApp();

const getAvatarRoute = createRoute({
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

avatars.openapi(getAvatarRoute, async (c) => {
  const { userId, file } = c.req.valid("param");
  const key = `avatars/${userId}/${file}`;
  const row = await c.env.DB.prepare("SELECT avatar_key FROM users WHERE id = ?")
    .bind(userId)
    .first<{ avatar_key: string | null }>();
  if (!row || row.avatar_key !== key) throw new HTTPException(404, { message: "No encontrado" });

  const object = await c.env.MEDIA.get(key);
  if (!object) throw new HTTPException(404, { message: "No encontrado" });

  const headers = new Headers();
  headers.set("content-type", "image/jpeg");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.set("content-disposition", "inline");
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
});

export default avatars;
