/** The three files a photo is stored in, as the download routes ask for them. */
export type MediaVariant = "thumb" | "original" | "display";

export type VariantRow = {
  originalKey: string;
  thumbKey: string;
  displayKey: string | null;
  originalPurgedAt: number | null;
};

/**
 * R2 key to serve for a variant, plus a key to try when the object is missing.
 * - original: the display once the original was purged (the route keeps working for old app builds that still ask for
 *   it); otherwise the original, falling back to the display if its object is gone.
 * - display: uploads from builds that predate it have none, so the original stands in.
 */
export function resolveVariantKey(row: VariantRow, variant: MediaVariant): { key: string; fallbackKey: string | null } {
  if (variant === "thumb") return { key: row.thumbKey, fallbackKey: null };
  if (variant === "display") return row.displayKey ? { key: row.displayKey, fallbackKey: null } : { key: row.originalKey, fallbackKey: null };
  if (row.originalPurgedAt !== null && row.displayKey) return { key: row.displayKey, fallbackKey: null };
  return { key: row.originalKey, fallbackKey: row.displayKey };
}
