import { z } from "@hono/zod-openapi";
import { ProfileVisibilitySchema, UserBadgeSchema } from "../../schemas";

export const PublicUserSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "User id" }),
    name: z.string().openapi({ example: "Cami" }),
    username: z.string().nullable().openapi({ example: "cami", description: "Unique handle without the @" }),
    avatarUrl: z.string().nullable(),
    bio: z.string().nullable().openapi({
      example: "Viajando por el sur",
      description: "Profile description; null if none. Always public, whatever canSee says",
    }),
    badge: UserBadgeSchema,
  })
  .openapi("PublicUser");

export const UserProfileSchema = z
  .object({
    user: PublicUserSchema,
    isFriend: z.boolean().openapi({ description: "Whether you and this user are friends (false for yourself)" }),
    blockedByMe: z.boolean().openapi({ description: "Whether you blocked this user" }),
    reportedByMe: z.boolean().openapi({ description: "Whether you reported this user (their profile, not a photo)" }),
    profileVisibility: ProfileVisibilitySchema,
    canSee: z.boolean().openapi({
      description: "Whether you can see the featured photos and the full friend list: it is you, a friend, or the profile is public, and neither of you blocked the other",
    }),
    friendCount: z.number().int().openapi({ description: "How many friends this user has (always public)" }),
    mutualCount: z.number().int().openapi({ description: "How many of your friends are also this user's friends (0 for yourself)" }),
  })
  .openapi("UserProfile");

export const UserFriendSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "User id" }),
    name: z.string().openapi({ example: "Cami" }),
    username: z.string().nullable().openapi({ example: "cami", description: "Unique handle without the @" }),
    avatarUrl: z.string().nullable(),
  })
  .openapi("UserFriend");

export const UserFriendsSchema = z
  .object({
    scope: z.enum(["all", "mutual"]).openapi({
      description: "all: every friend of this user (canSee); mutual: only the friends you have in common",
    }),
    friends: z.array(UserFriendSchema).openapi({ description: "Sorted by name, case-insensitive" }),
  })
  .openapi("UserFriends");
