import { deleteAccount } from "../account/account.service";
import { presignPut } from "../../lib/r2";
import { getNotificationSettings, getPrivacySettings, type NotificationSettings, type PrivacySettings, updateNotificationSettings, updatePrivacySettings } from "../../lib/settings";
import { deleteFeaturedByOthersOfAuthor } from "../featured/featured.repository";
import { assertStorageAvailable } from "../../lib/storage";
import { USERNAME_TAKEN_MESSAGE } from "../../lib/username";
import { badRequest, conflict } from "../../shared/errors";
import type { Env, UserRow } from "../../types";
import { isUsernameTaken } from "../usernames/usernames.service";
import { AVATAR_MAX_BYTES } from "./me.schemas";
import * as repo from "./me.repository";

const AVATAR_URL_TTL = 15 * 60;
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** The stored content type is client-controlled, so the magic bytes are the source of truth. */
function hasJpegMagic(bytes: Uint8Array): boolean {
  return bytes.length >= JPEG_MAGIC.length && JPEG_MAGIC.every((b, i) => bytes[i] === b);
}

export type ProfilePatch = {
  name?: string;
  username?: string;
  bio?: string | null;
  profileVisibility?: "friends" | "public";
};

/** Applies a partial profile update and returns the resulting user. */
export async function updateProfile(db: D1Database, user: UserRow, body: ProfilePatch): Promise<UserRow> {
  const next = {
    name: body.name ?? user.name,
    username: body.username ?? user.username,
    bio: body.bio === undefined ? user.bio : body.bio,
    profile_visibility: body.profileVisibility ?? user.profile_visibility,
  };
  if (body.username !== undefined && body.username !== user.username) {
    if (await isUsernameTaken(db, body.username, user.id)) throw conflict(USERNAME_TAKEN_MESSAGE);
  }
  try {
    await repo.updateProfile(db, user.id, next).run();
  } catch (err) {
    // Lost a race against another account taking the same username.
    if (String(err).includes("UNIQUE")) throw conflict(USERNAME_TAKEN_MESSAGE);
    throw err;
  }
  return { ...user, ...next };
}

export async function requestAvatarUpload(
  env: Env,
  origin: string,
  user: UserRow,
  sizeBytes: number,
): Promise<{ upload: string; expiresIn: number }> {
  await assertStorageAvailable(env, sizeBytes);
  // Don't leave the previous unconfirmed upload orphaned in R2.
  if (user.pending_avatar_key) await env.MEDIA.delete(user.pending_avatar_key);
  const key = `avatars/${user.id}/${crypto.randomUUID()}.jpg`;
  await repo.setPendingAvatarKey(env.DB, user.id, key).run();
  const upload = await presignPut(env, key, origin, sizeBytes, AVATAR_URL_TTL);
  return { upload, expiresIn: AVATAR_URL_TTL };
}

/** Validates the uploaded avatar, promotes it and returns the updated user. */
export async function completeAvatarUpload(env: Env, user: UserRow): Promise<UserRow> {
  const pending = user.pending_avatar_key;
  if (!pending) throw badRequest("Primero pedí dónde subir la foto");
  const object = await env.MEDIA.get(pending);
  if (!object) throw badRequest("Falta la foto; volvé a subirla");

  // Validate and copy the very same bytes: the presigned PUT stays valid after this call.
  const bytes = object.size > AVATAR_MAX_BYTES ? null : await object.arrayBuffer();
  if (!bytes || bytes.byteLength > AVATAR_MAX_BYTES || !hasJpegMagic(new Uint8Array(bytes))) {
    await env.MEDIA.delete(pending);
    await repo.clearPendingAvatarKey(env.DB, user.id).run();
    throw badRequest("La foto tiene que ser un JPEG de hasta 2 MB");
  }

  // Promote to a key that was never presigned, so nobody can overwrite it afterwards.
  const key = `avatars/${user.id}/${crypto.randomUUID()}.jpg`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  await env.MEDIA.delete(pending);
  await repo.promoteAvatar(env.DB, user.id, key).run();
  if (user.avatar_key) await env.MEDIA.delete(user.avatar_key);
  return { ...user, avatar_key: key };
}

export function removeAccount(env: Env, user: UserRow): Promise<void> {
  return deleteAccount(env, user);
}

export function listMyTrips(db: D1Database, userId: string): Promise<repo.MyTripRow[]> {
  return repo.listMyTrips(db, userId);
}

export async function registerPushToken(db: D1Database, userId: string, sessionId: string, token: string): Promise<void> {
  await repo.upsertPushToken(db, token, userId, sessionId, Date.now()).run();
}

export async function unregisterPushToken(db: D1Database, userId: string, token: string): Promise<void> {
  await repo.deletePushToken(db, token, userId).run();
}

export type UserSettings = { notifications: NotificationSettings; privacy: PrivacySettings };

export async function getSettings(db: D1Database, userId: string): Promise<UserSettings> {
  const [notifications, privacy] = await Promise.all([getNotificationSettings(db, [userId]), getPrivacySettings(db, userId)]);
  return { notifications: notifications.get(userId)!, privacy };
}

/**
 * Applies a partial update. Turning `allowFeaturing` off removes every photo of yours from other profiles
 * (yours stay); turning it back on restores nothing.
 */
export async function updateSettings(
  db: D1Database,
  userId: string,
  patch: { notifications?: Partial<NotificationSettings>; privacy?: Partial<PrivacySettings> },
): Promise<UserSettings> {
  if (patch.notifications && Object.keys(patch.notifications).length) await updateNotificationSettings(db, userId, patch.notifications);
  if (patch.privacy?.allowFeaturing !== undefined) {
    await db.batch([
      updatePrivacySettings(db, userId, patch.privacy.allowFeaturing),
      ...(patch.privacy.allowFeaturing ? [] : [deleteFeaturedByOthersOfAuthor(db, userId)]),
    ]);
  }
  return getSettings(db, userId);
}
