import { createRoute } from "@hono/zod-openapi";
import { requireSession } from "../../lib/auth";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { AuthSessionSchema } from "../../schemas";
import * as controller from "./auth.controller";
import { AppleSignInSchema, EmailStartSchema, EmailVerifyLinkSchema, EmailVerifySchema, GoogleSignInSchema } from "./auth.schemas";

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
    "Rate limited per email and per IP, and capped globally per day (429). Works for new and existing users alike, " +
    "and answers the same while new registrations are closed (the rejection comes when verifying).",
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
    "The code is case-insensitive and spaces or dashes are ignored; a malformed code is answered like a wrong one." +
    " While new registrations are closed (`GET /config` → `registrationsOpen: false`), an email with no account gets 403 `{ error, code: \"REGISTRATIONS_CLOSED\" }` here (after the code or link checks out), and existing accounts sign in as always.",
  request: { body: { content: { "application/json": { schema: EmailVerifySchema } }, required: true } },
  responses: { 200: json(AuthSessionSchema, "Signed in"), ...errors(400, 403) },
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
    "Every failure answers the same 400. Only POST: the token is never accepted in a URL." +
    " While new registrations are closed (`GET /config` → `registrationsOpen: false`), an email with no account gets 403 `{ error, code: \"REGISTRATIONS_CLOSED\" }` here (after the code or link checks out), and existing accounts sign in as always.",
  request: { body: { content: { "application/json": { schema: EmailVerifyLinkSchema } }, required: true } },
  responses: { 200: json(AuthSessionSchema, "Signed in"), ...errors(400, 403) },
});

// ---------- Google ----------

export const googleRoute = createRoute({
  method: "post",
  path: "/google",
  tags,
  summary: "Sign in with a Google ID token",
  description:
    "Same result as `/auth/email/verify`. The token must be signed by Google, issued for one of our OAuth clients (`GOOGLE_CLIENT_IDS`), " +
    "not expired, and carry an email Google verified; any failure is the same 400. The Google account id finds the user it was linked to " +
    "before (even if its email changed); otherwise the verified email signs into that email's account or creates it, and links it. " +
    "An existing account is only linked when Google owns the address (Gmail, or a Workspace domain matching `hd`); for any other " +
    "address with an account the answer is 409 (sign in with the emailed code instead). " +
    "An account without a name gets the Google profile name (single spaces, up to 30 characters) as a suggestion: it stays incomplete " +
    "(`isNew`) until it has a username, so the profile step shows it prefilled. " +
    "503 when Google sign-in is not configured, or in degraded mode for an email without an account. " +
    "While new registrations are closed, a Google account with no Rollo account (no linked identity, no account with that email) gets 403 `{ error, code: \"REGISTRATIONS_CLOSED\" }`.",
  request: { body: { content: { "application/json": { schema: GoogleSignInSchema } }, required: true } },
  responses: { 200: json(AuthSessionSchema, "Signed in"), ...errors(400, 403, 409, 503) },
});

// ---------- Apple ----------

export const appleRoute = createRoute({
  method: "post",
  path: "/apple",
  tags,
  summary: "Sign in with a Sign in with Apple identity token",
  description:
    "Same result as `/auth/email/verify` and the same rules as `/auth/google`. The token must be signed by Apple, issued for one of " +
    "our bundle ids (`APPLE_CLIENT_IDS`) and not expired; if it carries an email, Apple must have verified it. Any failure is the " +
    "same 400. The Apple account id finds the user it was linked to before (later tokens may come without an email); otherwise the " +
    "email signs into that email's account or creates it, and links it. An existing account is only linked when Apple owns the " +
    "address (iCloud, or the Hide My Email relay); any other address with an account answers 409 (sign in with the emailed code). " +
    "A first sign-in without an email is a 400. `name`, which Apple gives only on the first sign-in, prefills an account without a name. " +
    "503 when Apple sign-in is not configured, or in degraded mode for an email without an account. " +
    "While new registrations are closed, an Apple account with no Rollo account gets 403 `{ error, code: \"REGISTRATIONS_CLOSED\" }`.",
  request: { body: { content: { "application/json": { schema: AppleSignInSchema } }, required: true } },
  responses: { 200: json(AuthSessionSchema, "Signed in"), ...errors(400, 403, 409, 503) },
});

// ---------- Logout ----------

export const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  tags,
  summary: "Sign out (deletes the current session)",
  security: bearerAuth,
  middleware: [requireSession] as const,
  responses: { 204: { description: "Signed out" }, ...errors(401) },
});

const auth = createApp();

auth.openapi(startRoute, controller.start);
auth.openapi(verifyRoute, controller.verify);
auth.openapi(verifyLinkRoute, controller.verifyLink);
auth.openapi(googleRoute, controller.google);
auth.openapi(appleRoute, controller.apple);
auth.openapi(logoutRoute, controller.logout);

export default auth;
