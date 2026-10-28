import { badRequest } from "../shared/errors";

/** Opaque keyset cursor `(at, id)` for lists ordered newest first by a timestamp, ties broken by id. */
export type TimeCursor = { at: number; id: string };

export function encodeCursor(c: TimeCursor): string {
  return btoa(`${c.at}:${c.id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(raw: string): TimeCursor {
  try {
    const [at, id, ...rest] = atob(raw.replace(/-/g, "+").replace(/_/g, "/")).split(":");
    const n = Number(at);
    if (rest.length === 0 && id && Number.isSafeInteger(n) && n >= 0) return { at: n, id };
  } catch {
    // falls through
  }
  throw badRequest("Cursor inválido");
}
