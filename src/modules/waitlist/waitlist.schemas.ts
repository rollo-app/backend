import { z } from "@hono/zod-openapi";
import { emailField } from "../auth/auth.schemas";

export const WaitlistJoinSchema = z
  .object({
    email: emailField,
    source: z.enum(["app", "web"]).default("app").openapi({ description: "Where the person signed up. Defaults to `app`." }),
    consent: z.literal(true, { error: "Necesitamos tu consentimiento para anotarte" }).openapi({
      description: "Must be `true`: the person agreed to get an email when Rollo opens.",
    }),
  })
  .openapi("WaitlistJoinRequest");

export type WaitlistStatus = "pending" | "confirmed" | "unsubscribed";
