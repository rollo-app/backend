import { createRoute } from "@hono/zod-openapi";
import { requireTripMemberOrNotFound, requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { TripParams } from "../../schemas";
import * as controller from "./moments.controller";
import { MyMomentsSchema } from "./moments.schemas";

const tags = ["Moments"];

export const listMyMomentsRoute = createRoute({
  method: "get",
  path: "/{tripId}/moments",
  tags,
  summary: "My daily moments",
  description:
    "The moments of the caller for each remaining day of the trip, from today (trip local date) to the end, that can still be taken. " +
    "The server draws and stores them the first time they are asked for and never re-draws. The app schedules local notifications from them. " +
    "Empty when the trip has the moment off, is over or revealed, or the user turned `dailyMoment` off. Non-members and ex-members get 404.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMemberOrNotFound] as const,
  request: { params: TripParams },
  responses: { 200: json(MyMomentsSchema, "My moments"), ...errors(401, 404) },
});

const moments = createApp();

moments.openapi(listMyMomentsRoute, controller.listMine);

export default moments;
