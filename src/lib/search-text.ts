/** Text normalization for user search (by @username or name). */

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 30;

/** Lowercase, accent-free, trimmed text with single spaces. */
export function searchText(input: string): string {
  return input.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\s+/g, " ");
}

/** A raw search query: drops every leading "@" (once trimmed) and normalizes. */
export function normalizeSearchQuery(raw: string): string {
  return searchText(raw.trim().replace(/^@+/, ""));
}

/** Value of `users.name_search`: the normalized name with a leading space, so `LIKE '% prefix%'` matches word starts. */
export function nameSearchColumn(name: string | null): string | null {
  if (name === null) return null;
  const text = searchText(name);
  return text === "" ? null : ` ${text}`;
}
