import { createRoute, z } from "@hono/zod-openapi";
import { createApp, errors } from "../../lib/openapi";
import { CoverParams } from "./covers.schemas";
import * as service from "./covers.service";

export const getCoverRoute = createRoute({
  method: "get",
  path: "/{tripId}/{file}",
  tags: ["Trips"],
  summary: "Download an event's cover",
  description:
    "Public (no token) so it can be used directly as an image URL, also by the event preview and the website. Only the event's current cover is served; " +
    "file names are random, so older or guessed ones return 404.",
  request: { params: CoverParams },
  responses: {
    200: { description: "Cover", content: { "image/jpeg": { schema: z.string().openapi({ format: "binary" }) } } },
    ...errors(404),
  },
});

const covers = createApp();

covers.openapi(getCoverRoute, async (c) => {
  const { tripId, file } = c.req.valid("param");
  const object = await service.getCurrentCover(c.env, tripId, file);

  const headers = new Headers();
  headers.set("content-type", "image/jpeg");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.set("content-disposition", "inline");
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
});

export default covers;
