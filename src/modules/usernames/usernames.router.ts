import { createRoute } from "@hono/zod-openapi";
import { requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import * as controller from "./usernames.controller";
import { UsernameAvailabilitySchema, UsernameParams } from "./usernames.schemas";

export const checkRoute = createRoute({
  method: "get",
  path: "/{username}",
  tags: ["Profile"],
  summary: "Check if a username is available",
  description:
    "Normalizes the username (optional @, lowercase) and says whether nobody else has it. " +
    "Your own current username counts as available. 400 if it breaks the format rules. For checking while typing.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { params: UsernameParams },
  responses: { 200: json(UsernameAvailabilitySchema, "Availability"), ...errors(400, 401) },
});

const usernames = createApp();

usernames.openapi(checkRoute, controller.check);

export default usernames;
