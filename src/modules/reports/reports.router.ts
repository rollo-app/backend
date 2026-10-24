import { createRoute } from "@hono/zod-openapi";
import { requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors } from "../../lib/openapi";
import * as controller from "./reports.controller";
import { CreateReportSchema } from "./reports.schemas";

export const createReportRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Reports"],
  summary: "Report a photo or a person",
  description:
    "Send `mediaId` or `userId`. Idempotent: reporting the same photo or person again is a 204 and does not email support again. " +
    "A reported photo disappears from the reporter's own views (and from their featured photos). At most 3 reports and blocks per user per 24 hours (and 20 per day overall) are emailed to support; the rest are stored without email. More than 50 reports per user per 24 hours is a 429. 404 if the photo is not one the reporter can see; 400 if it is theirs.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { body: { content: { "application/json": { schema: CreateReportSchema } }, required: true } },
  responses: { 204: { description: "Reported" }, ...errors(400, 401, 404, 429) },
});

const reports = createApp();

reports.openapi(createReportRoute, controller.create);

export default reports;
