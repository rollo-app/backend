import { OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../schemas";
import type { AppEnv } from "../types";

/** App de Hono con validación por contrato. Los errores de validación responden `{ error }`. */
export function createApp() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        const field = issue?.path.join(".");
        const message = issue ? (field ? `${field}: ${issue.message}` : issue.message) : "Datos inválidos";
        return c.json({ error: message }, 400);
      }
    },
  });
}

export const bearerAuth = [{ bearerAuth: [] }];

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Datos inválidos",
  401: "Falta el token o es inválido",
  403: "Sin permiso",
  404: "No encontrado",
  409: "Conflicto con el estado actual",
  429: "Se alcanzó el límite del día",
};

/** Respuestas de error documentadas para un endpoint. */
export function errors(...codes: (keyof typeof ERROR_DESCRIPTIONS)[]) {
  return Object.fromEntries(
    codes.map((code) => [
      code,
      { description: ERROR_DESCRIPTIONS[code]!, content: { "application/json": { schema: ErrorSchema } } },
    ]),
  );
}

export function json<T>(schema: T, description: string) {
  return { description, content: { "application/json": { schema } } };
}
