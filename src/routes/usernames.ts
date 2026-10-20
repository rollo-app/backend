import { createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireUser } from "../lib/auth";
import { bearerAuth, createApp, errors, json } from "../lib/openapi";
import { isValidUsername, normalizeUsername, USERNAME_INVALID_MESSAGE } from "../lib/username";
import { UsernameAvailabilitySchema, UsernameParams } from "../schemas";

const usernames = createApp();

const checkRoute = createRoute({
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

usernames.openapi(checkRoute, async (c) => {
  const username = normalizeUsername(c.req.valid("param").username);
  if (!isValidUsername(username)) throw new HTTPException(400, { message: USERNAME_INVALID_MESSAGE });
  const owner = await c.env.DB.prepare("SELECT id FROM users WHERE username = ? AND id != ?")
    .bind(username, c.get("user").id)
    .first();
  return c.json({ available: !owner, username }, 200);
});

export default usernames;
