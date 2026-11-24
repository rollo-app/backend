import { createRoute } from "@hono/zod-openapi";
import { requireAdmin, requireTripMember, requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { TripParams } from "../../schemas";
import * as controller from "./contest.controller";
import { ContestSchema, FinalistParams } from "./contest.schemas";

const tags = ["Contest"];

export const getContestRoute = createRoute({
  method: "get",
  path: "/{tripId}/contest",
  tags,
  summary: "Photo contest status",
  description:
    "Status (`pending` before the end, `selecting` until the reveal, `voting`, `tied`, `closed`, `cancelled`), `closesAt`, finalists, your vote and the winner. " +
    "A guest gets no finalists before the reveal. `votes` is null unless `closed`. Finalists that are deleted, archived, from someone who left, or blocked/reported by you are left out. 404 if the event has no contest.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember] as const,
  request: { params: TripParams },
  responses: { 200: json(ContestSchema, "Contest"), ...errors(401, 403, 404, 410, 428) },
});

export const addFinalistRoute = createRoute({
  method: "put",
  path: "/{tripId}/contest/finalists/{mediaId}",
  tags,
  summary: "Mark a photo as finalist (organizer)",
  description:
    "Only between the end of the event and the reveal (409 otherwise). The photo must be an uploaded, not deleted photo of the event that is not a moment selfie (400). At most 10 (409). Idempotent.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireAdmin] as const,
  request: { params: FinalistParams },
  responses: { 204: { description: "Marked" }, ...errors(400, 401, 403, 409, 410, 428) },
});

export const removeFinalistRoute = createRoute({
  method: "delete",
  path: "/{tripId}/contest/finalists/{mediaId}",
  tags,
  summary: "Unmark a finalist (organizer)",
  description: "Same window as marking it (409 otherwise). Idempotent.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireAdmin] as const,
  request: { params: FinalistParams },
  responses: { 204: { description: "Unmarked" }, ...errors(401, 403, 409, 410, 428) },
});

const contest = createApp();

contest.openapi(getContestRoute, controller.get);
contest.openapi(addFinalistRoute, controller.add);
contest.openapi(removeFinalistRoute, controller.remove);

export default contest;
