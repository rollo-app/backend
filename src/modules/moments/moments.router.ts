import { createRoute } from "@hono/zod-openapi";
import { requireTripMember, requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { TripParams } from "../../schemas";
import * as controller from "./moments.controller";
import { AllMyMomentsSchema, MyMomentsSchema } from "./moments.schemas";

const tags = ["Moments"];

export const listMyMomentsRoute = createRoute({
  method: "get",
  path: "/{tripId}/moments",
  tags,
  summary: "My daily moments",
  description:
    "The moments of the caller for each remaining day of the trip, from today (trip local date) to the end, that can still be taken. " +
    "The server draws and stores them the first time they are asked for and never re-draws. The app schedules local notifications from them. " +
    "Empty when the trip has the moment off, is over or revealed, or the user turned `dailyMoment` off. Non-members and ex-members get 403, like `GET /trips/{tripId}`.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember] as const,
  request: { params: TripParams },
  responses: { 200: json(MyMomentsSchema, "My moments"), ...errors(401, 403) },
});

export const listAllMyMomentsRoute = createRoute({
  method: "get",
  path: "/moments",
  tags,
  summary: "My daily moments in all my rollos",
  description:
    "The moments of the caller for every rollo where they are an active member, the moment is on, the rollo is not revealed and it is within the " +
    "scheduling window (from 3 days before the start until the end). One call instead of one `GET /trips/{tripId}/moments` per rollo. " +
    "Each rollo carries exactly what that endpoint would return for it, possibly empty (so the app can cancel old notifications). " +
    "Like the per-rollo endpoint, the first time it draws and stores the missing moments and never re-draws. Ordered by rollo id.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 200: json(AllMyMomentsSchema, "My moments in all my rollos"), ...errors(401) },
});

export const meMoments = createApp();
meMoments.openapi(listAllMyMomentsRoute, controller.listAllMine);

const moments = createApp();

moments.openapi(listMyMomentsRoute, controller.listMine);

export default moments;
