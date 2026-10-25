import { notFound } from "../../shared/errors";
import type { Deps } from "../../container";
import type { StoredObject } from "../../ports/storage";
import * as repo from "./avatars.repository";

/** The user's current avatar object; anything else (older, guessed or missing) is a 404. */
export async function getCurrentAvatar(deps: Pick<Deps, "db" | "storage">, userId: string, file: string): Promise<StoredObject> {
  const key = `avatars/${userId}/${file}`;
  const avatarKey = await repo.findAvatarKey(deps.db, userId);
  if (avatarKey === undefined || avatarKey !== key) throw notFound();

  const object = await deps.storage.get(key);
  if (!object) throw notFound();
  return object;
}
