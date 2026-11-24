import { badRequest } from "../shared/errors";

export const DESCRIPTION_MAX_LENGTH = 300;
export const DESCRIPTION_MAX_LINES = 6;

/** Trimmed; an empty description is stored as null. A CRLF (or a lone CR) counts as one line break. 400 over 300 characters or 6 lines. */
export function normalizeDescription(raw: string): string | null {
  const s = raw.trim();
  if (s.length > DESCRIPTION_MAX_LENGTH) throw badRequest(`La descripción puede tener hasta ${DESCRIPTION_MAX_LENGTH} caracteres`);
  if (s.split(/\r\n|\r|\n/).length > DESCRIPTION_MAX_LINES) throw badRequest(`La descripción puede tener hasta ${DESCRIPTION_MAX_LINES} renglones`);
  return s === "" ? null : s;
}
