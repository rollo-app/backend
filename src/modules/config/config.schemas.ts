import { z } from "@hono/zod-openapi";

export const AppConfigSchema = z
  .object({
    registrationsOpen: z.boolean().openapi({ description: "false while new accounts cannot be created (the app shows the waitlist instead of sign-up)." }),
  })
  .openapi("AppConfig");
