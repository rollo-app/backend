import { createRoute } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { createApp, errors, json } from "../../lib/openapi";
import { rateLimitByIp } from "../../lib/rate-limit";
import * as controller from "./events.controller";
import { EventCodeParams, EventPreviewSchema } from "./events.schemas";

export const previewEventRoute = createRoute({
  method: "get",
  path: "/{code}",
  tags: ["Events"],
  summary: "Preview an event by its invite code",
  description:
    "No token. The name, cover and groups the guest picks from before joining (`POST /trips/join`), and whether the event was already revealed. " +
    "404 'Código inválido' if the code does not exist or belongs to a regular trip. Limited per IP (429, a roomy budget: a venue shares one IP). CORS: open to the website (`https://rolloproject.com`, `https://www.rolloproject.com`), GET only.",
  middleware: [rateLimitByIp("RL_IP_PUBLIC")] as const,
  request: { params: EventCodeParams },
  responses: { 200: json(EventPreviewSchema, "Event preview"), ...errors(404, 429) },
});

const events = createApp();

/** The website (`/join/<CODE>`) reads this route from the browser; no other route is open to it. */
const WEBSITE_ORIGINS = ["https://rolloproject.com", "https://www.rolloproject.com"];
events.use("/:code", cors({ origin: (origin) => (WEBSITE_ORIGINS.includes(origin) ? origin : null), allowMethods: ["GET"], maxAge: 86400 }));

events.openapi(previewEventRoute, controller.preview);

export default events;
