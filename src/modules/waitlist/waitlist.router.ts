import { createRoute } from "@hono/zod-openapi";
import { Hono } from "hono";
import { createApp, errors } from "../../lib/openapi";
import type { AppEnv } from "../../types";
import * as controller from "./waitlist.controller";
import { WaitlistJoinSchema } from "./waitlist.schemas";

export const joinRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Waitlist"],
  summary: "Join the waitlist (double opt-in)",
  description:
    "No token. For people who cannot sign up yet (registrations closed). Always 204 for valid input, whether or not the email was already " +
    "listed, confirmed, throttled or over a daily cap: nothing about the list is revealed. 400 for an invalid email or `consent` other than " +
    "`true`. Sends one confirmation email (a confirm and an unsubscribe link) at most once per address per 24 h; someone who unsubscribed " +
    "and posts again gets a new one. Already confirmed addresses get nothing. Capped per IP and globally per day (still 204, nothing sent). " +
    "502 only if the email provider fails.",
  request: { body: { content: { "application/json": { schema: WaitlistJoinSchema } }, required: true } },
  responses: { 204: { description: "Accepted" }, ...errors(400, 502) },
});

const waitlist = createApp();

waitlist.openapi(joinRoute, controller.join);

/**
 * The links in the confirmation email (`/waitlist/confirm?token=` and `/waitlist/unsubscribe?token=`) open in a browser and
 * answer a small HTML page, not JSON: a plain Hono app outside the contract (the mobile app never calls them), like `/admin/*`.
 */
export const waitlistPages = new Hono<AppEnv>();
// GET shows a page with a button and changes nothing (mail scanners open links); the button POSTs the token.
waitlistPages.get("/confirm", controller.confirmPageGet);
waitlistPages.post("/confirm", controller.confirm);
waitlistPages.get("/unsubscribe", controller.unsubscribePageGet);
// Also the RFC 8058 one-click target (`List-Unsubscribe-Post`): the token stays in the query, the body is `List-Unsubscribe=One-Click`.
waitlistPages.post("/unsubscribe", controller.unsubscribe);

export default waitlist;
