import { isValidUsername, normalizeUsername, USERNAME_INVALID_MESSAGE } from "../../lib/username";
import { badRequest } from "../../shared/errors";
import * as repo from "./usernames.repository";

/** Normalizes the username and says whether nobody else has it (your own counts as available). */
export async function checkAvailability(db: D1Database, userId: string, raw: string): Promise<{ available: boolean; username: string }> {
  const username = normalizeUsername(raw);
  if (!isValidUsername(username)) throw badRequest(USERNAME_INVALID_MESSAGE);
  const owner = await repo.findOtherUserWithUsername(db, username, userId);
  return { available: !owner, username };
}
