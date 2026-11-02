import { deleteAccount } from "../modules/account/account.service";
import type { Env, UserRow } from "../types";

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH = 50;

/**
 * Cron: deletes accounts that never completed their profile (no name or no @username) and were abandoned: created over 7 days
 * ago, no session used in the last 7 days, and nothing attached (no membership, friendship or friend request).
 * Bounded per run; the rest is picked up by the next runs. If the person comes back, login creates the account again.
 */
export async function purgeIncompleteAccounts(env: Env, now = Date.now()): Promise<void> {
  const cutoff = now - STALE_AFTER_MS;
  const { results } = await env.DB
    .prepare(
      `SELECT u.* FROM users u
       WHERE (u.name IS NULL OR TRIM(u.name) = '' OR u.username IS NULL)
         AND u.created_at < ?1
         AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.last_used_at >= ?1)
         AND NOT EXISTS (SELECT 1 FROM members m WHERE m.user_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.user_a = u.id OR f.user_b = u.id)
         AND NOT EXISTS (SELECT 1 FROM friend_requests r WHERE r.from_user_id = u.id OR r.to_user_id = u.id)
       ORDER BY u.created_at LIMIT ?2`,
    )
    .bind(cutoff, BATCH)
    .all<UserRow>();
  for (const user of results) {
    try {
      await deleteAccount(env, user);
    } catch (err) {
      // One broken account must not stall the whole purge.
      console.error("purgeIncompleteAccounts: could not delete", user.id, err);
    }
  }
}
