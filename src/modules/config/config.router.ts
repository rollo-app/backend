import { createRoute } from "@hono/zod-openapi";
import { createApp, json } from "../../lib/openapi";
import * as controller from "./config.controller";
import { AppConfigSchema } from "./config.schemas";

export const getConfigRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Config"],
  summary: "Public app configuration",
  description:
    "No token. `registrationsOpen` is false while a superadmin has closed new registrations: the app then shows its waitlist instead of " +
    "sign-up (existing accounts still sign in). The value can lag up to a minute after a change.",
  responses: { 200: json(AppConfigSchema, "Configuration") },
});

const config = createApp();

config.openapi(getConfigRoute, controller.getConfig);

export default config;
