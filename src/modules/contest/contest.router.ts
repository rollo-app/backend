import { createRoute, z } from "@hono/zod-openapi";
import { requireAdmin, requireTripMember, requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { TripParams } from "../../schemas";
import * as controller from "./contest.controller";
import { rateLimit } from "../../lib/rate-limit";
import { ContestSchema, FinalistFileParams, FinalistParams, VoteBody, WinnerBody } from "./contest.schemas";

const tags = ["Contest"];

export const getContestRoute = createRoute({
  method: "get",
  path: "/{tripId}/contest",
  tags,
  summary: "Photo contest status",
  description:
    "Status (`pending` before the end, `selecting` until the reveal, `voting`, `closing` (voting over, the cron has not closed it), `tied`, `closed`, `cancelled`), `closesAt`, finalists, your vote and the winner. " +
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
    "Only between the end of the event and the reveal (409 otherwise). The photo must be an uploaded, not deleted photo of the event that is not a moment selfie (400). Idempotent.",
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

export const voteRoute = createRoute({
  method: "put",
  path: "/{tripId}/contest/vote",
  tags,
  summary: "Vote for a finalist",
  description:
    "Only while `voting` (409 \"La votación no está abierta.\" otherwise). One vote per person: voting again changes it. " +
    "404 if the photo is not a finalist that counts for you (also with a block with its author or a report); 400 for your own photo.",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_EXPENSIVE"), requireTripMember] as const,
  request: { params: TripParams, body: { content: { "application/json": { schema: VoteBody } }, required: true } },
  responses: { 204: { description: "Voted" }, ...errors(400, 401, 403, 404, 409, 410, 428, 429) },
});

export const unvoteRoute = createRoute({
  method: "delete",
  path: "/{tripId}/contest/vote",
  tags,
  summary: "Remove your vote",
  description: "Idempotent: 204 also if you had not voted. Outside the voting window it changes nothing.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember] as const,
  request: { params: TripParams },
  responses: { 204: { description: "Not voting anymore" }, ...errors(401, 403, 410, 428) },
});

export const finalistFileRoute = createRoute({
  method: "get",
  path: "/{tripId}/contest/finalists/{mediaId}/{variant}",
  tags,
  summary: "Download a finalist's file",
  description:
    "Any active member, from the voting until after the contest closes (organizers also while choosing the finalists), even if they do not share a group with the author. " +
    "Only for a finalist that counts for you (404 otherwise, also with a block or a report). `display` is the 2048px version (the original for uploads that have none). " +
    "Streamed from R2 with the same Bearer token; supports `Range`.",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_FILES"), requireTripMember] as const,
  request: { params: FinalistFileParams },
  responses: {
    200: { description: "File", content: { "image/jpeg": { schema: z.string().openapi({ format: "binary" }) } } },
    206: { description: "Part of the file, for a single `Range: bytes=...` request" },
    416: { description: "The requested range starts past the end of the file" },
    ...errors(401, 403, 404, 410, 428, 429),
  },
});

export const pickWinnerRoute = createRoute({
  method: "post",
  path: "/{tripId}/contest/winner",
  tags,
  summary: "Break a tie: pick the winner (organizer)",
  description:
    "Only while `tied` (409 otherwise, also once closed) and only one of `tiedMediaIds` (400). Closes the contest and announces the winner by push, like the cron does at the close.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireAdmin] as const,
  request: { params: TripParams, body: { content: { "application/json": { schema: WinnerBody } }, required: true } },
  responses: { 204: { description: "Closed with that winner" }, ...errors(400, 401, 403, 404, 409, 410, 428) },
});

const contest = createApp();

contest.openapi(getContestRoute, controller.get);
contest.openapi(addFinalistRoute, controller.add);
contest.openapi(removeFinalistRoute, controller.remove);
contest.openapi(voteRoute, controller.vote);
contest.openapi(unvoteRoute, controller.unvote);
contest.openapi(finalistFileRoute, controller.finalistFile);
contest.openapi(pickWinnerRoute, controller.pickWinner);

export default contest;
