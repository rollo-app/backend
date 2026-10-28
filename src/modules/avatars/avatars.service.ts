import { notFound } from "../../shared/errors";
import type { Env } from "../../types";
import * as repo from "./avatars.repository";

/** The user's current avatar object; anything else (older, guessed or missing) is a 404. */
export async function getCurrentAvatar(env: Env, userId: string, file: string): Promise<R2ObjectBody> {
  const key = `avatars/${userId}/${file}`;
  const avatarKey = await repo.findAvatarKey(env.DB, userId);
  if (avatarKey === undefined || avatarKey !== key) throw notFound();

  const object = await env.MEDIA.get(key);
  if (!object) throw notFound();
  return object;
}
