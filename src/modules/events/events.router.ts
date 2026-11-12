import { createRoute } from "@hono/zod-openapi";
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
    "404 'Código inválido' if the code does not exist or belongs to a regular trip. Limited per IP (429).",
  middleware: [rateLimitByIp("RL_SEARCH")] as const,
  request: { params: EventCodeParams },
  responses: { 200: json(EventPreviewSchema, "Event preview"), ...errors(404, 429) },
});

const events = createApp();

events.openapi(previewEventRoute, controller.preview);

export default events;
