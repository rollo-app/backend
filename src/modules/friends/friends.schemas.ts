import { z } from "@hono/zod-openapi";
import { epochMs, FriendSchema } from "../../schemas";

export const FriendsSchema = z.object({ friends: z.array(FriendSchema) }).openapi("Friends");

export const FriendLinkSchema = z
  .object({
    code: z.string().openapi({ example: "K7M2QX9A", description: "8-character code; the link is rollo://friends/<code>" }),
    expiresAt: epochMs("The link stops working at this instant (1 hour after it was generated)"),
  })
  .openapi("FriendLink");

export const ClaimFriendLinkSchema = z
  .object({ code: z.string().trim().max(64).openapi({ example: "K7M2QX9A", description: "Case-insensitive; spaces and dashes are ignored" }) })
  .openapi("ClaimFriendLinkRequest");

export const ClaimResponseSchema = z
  .object({
    claimToken: z.string().openapi({ description: "Permission to redeem this link while signed in. Valid for 24 hours" }),
    expiresAt: epochMs("The claim token stops working at this instant"),
    creator: z.object({
      name: z.string(),
      username: z.string().nullable(),
      avatarUrl: z.string().nullable(),
    }),
  })
  .openapi("ClaimResponse");

export const RedeemFriendSchema = z
  .object({
    code: z.string().trim().max(64).optional().openapi({ description: "Friend code typed or taken from a link that is still valid" }),
    claimToken: z.string().trim().max(200).optional().openapi({ description: "Token returned by /friend-links/claim" }),
  })
  .refine((b) => (b.code !== undefined) !== (b.claimToken !== undefined), "Mandá el código o el permiso de canje, no los dos")
  .openapi("RedeemFriendRequest");

export const FriendResponseSchema = z.object({ friend: FriendSchema }).openapi("FriendResponse");

export const CommonTripSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    startsAt: epochMs("Trip start"),
    endsAt: epochMs("Trip end"),
    revealed: z.boolean(),
  })
  .openapi("CommonTrip");

export const FriendProfileSchema = z
  .object({
    friend: FriendSchema,
    commonTrips: z.array(CommonTripSchema).openapi({
      description: "Rollos both of you are active members of, most recent start first",
    }),
  })
  .openapi("FriendProfile");
