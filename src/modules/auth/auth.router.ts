import { createRoute } from "@hono/zod-openapi";
import { requireUser } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { AuthSessionSchema } from "../../schemas";
import * as controller from "./auth.controller";
import { EmailStartSchema, EmailVerifyLinkSchema, EmailVerifySchema } from "./auth.schemas";

const tags = ["Auth"];

// ---------- Start ----------

export const startRoute = createRoute({
  method: "post",
  path: "/email/start",
  tags,
  summary: "Request a login code by email",
  description:
    "Sends a 6-character code (letters and digits, no 0/O/1/I/L; valid 5 minutes, 5 attempts) and, only when `linkChallenge` is sent, " +
    "a magic link for the same attempt (`<LOGIN_LINK_URL>#t=<token>&e=<email>`, see `/auth/email/verify-link`), bound to that challenge. " +
    "Using either one consumes both. A new request invalidates the previous codes. " +
    "Rate limited per email and per IP, and capped globally per day (429). Works for new and existing users alike.",
  request: { body: { content: { "application/json": { schema: EmailStartSchema } }, required: true } },
  responses: { 204: { description: "Code sent" }, ...errors(400, 429, 502) },
});

// ---------- Verify ----------

export const verifyRoute = createRoute({
  method: "post",
  path: "/email/verify",
  tags,
  summary: "Exchange the emailed code for a session token",
  description:
    "Creates the user on the first successful verification. `isNew` is true while the user has no name. " +
    "The code is case-insensitive and spaces or dashes are ignored; a malformed code is answered like a wrong one.",
  request: { body: { content: { "application/json": { schema: EmailVerifySchema } }, required: true } },
  responses: { 200: json(AuthSessionSchema, "Signed in"), ...errors(400) },
});

// ---------- Verify link ----------

export const verifyLinkRoute = createRoute({
  method: "post",
  path: "/email/verify-link",
  tags,
  summary: "Exchange the emailed magic-link token for a session token",
  description:
    "Same result as `/auth/email/verify`, with the token from the link's fragment instead of the code. Needs the `verifier` whose " +
    "SHA-256 was sent as `linkChallenge` to `/auth/email/start`: the link only signs in the phone that asked for it. Shares the code's " +
    "expiry, attempts and single use: a wrong or missing token or verifier uses up an attempt, and after the link or the code is used " +
    "neither works again. Attempts started without a challenge have no link, so this always fails for them. " +
    "Every failure answers the same 400. Only POST: the token is never accepted in a URL.",
  request: { body: { content: { "application/json": { schema: EmailVerifyLinkSchema } }, required: true } },
  responses: { 200: json(AuthSessionSchema, "Signed in"), ...errors(400) },
});

// ---------- Logout ----------

export const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  tags,
  summary: "Sign out (deletes the current session)",
  security: bearerAuth,
  middleware: [requireUser] as const,
  responses: { 204: { description: "Signed out" }, ...errors(401) },
});

const auth = createApp();

auth.openapi(startRoute, controller.start);
auth.openapi(verifyRoute, controller.verify);
auth.openapi(verifyLinkRoute, controller.verifyLink);
auth.openapi(logoutRoute, controller.logout);

export default auth;
