import { z } from "@hono/zod-openapi";
import { isEmail } from "../../lib/util";

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isEmail, "Ingresá un email válido")
  .openapi({ example: "juani@example.com", description: "Trimmed and lowercased" });

/** 32 bytes in base64url without padding: a SHA-256 digest (the link challenge). */
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;

export const EmailStartSchema = z
  .object({
    email: emailField,
    linkChallenge: z
      .string()
      .regex(BASE64URL_SHA256, "linkChallenge inválido")
      .optional()
      .openapi({
        example: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        description:
          "base64url (no padding) of SHA-256 of a random verifier the app keeps on the phone (PKCE-style, 43 chars). " +
          "Only with it does the email include a magic link, and the link only works with that verifier (`/auth/email/verify-link`). " +
          "Without it (old app builds) the email carries only the code.",
      }),
  })
  .openapi("EmailStartRequest");

export const EmailVerifySchema = z
  .object({ email: emailField, code: z
      .string()
      .trim()
      .max(16)
      .openapi({
        example: "K7M2QX",
        description:
          "6-character code from the email (letters and digits, no 0/O/1/I/L). Case-insensitive; spaces and dashes are ignored",
      }) })
  .openapi("EmailVerifyRequest");

export const EmailVerifyLinkSchema = z
  .object({
    email: emailField,
    token: z.string().openapi({
      example: "q3N0dGhpcy1pcy1ub3QtYS1yZWFsLXRva2VuLWp1c3QtYW4tZXhhbXBsZQ",
      description: "Token from the magic link in the email (the `t` parameter of its fragment)",
    }),
    verifier: z.string().max(256).optional().openapi({
      example: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      description:
        "The verifier whose SHA-256 was sent as `linkChallenge` to `/auth/email/start` (43–128 chars of `A-Z a-z 0-9 - . _ ~`). " +
        "Without the right one the link fails like a wrong token.",
    }),
  })
  .openapi("EmailVerifyLinkRequest");
