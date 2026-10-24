import { isValidUsername, normalizeUsername, USERNAME_INVALID_MESSAGE } from "../../lib/username";
import { badRequest } from "../../shared/errors";
import * as repo from "./usernames.repository";

/** Whether another user already has `username` (your own doesn't count). */
export async function isUsernameTaken(db: D1Database, username: string, userId: string): Promise<boolean> {
  return (await repo.findOtherUserWithUsername(db, username, userId)) !== null;
}

/** Normalizes the username and says whether nobody else has it (your own counts as available). */
export async function checkAvailability(db: D1Database, userId: string, raw: string): Promise<{ available: boolean; username: string }> {
  const username = normalizeUsername(raw);
  if (!isValidUsername(username)) throw badRequest(USERNAME_INVALID_MESSAGE);
  return { available: !(await isUsernameTaken(db, username, userId)), username };
}
