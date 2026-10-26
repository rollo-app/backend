import { z } from "@hono/zod-openapi";
import { epochMs, FriendSchema } from "../../schemas";

export const SendFriendRequestResponseSchema = z
  .object({
    status: z.enum(["sent", "friends"]).openapi({
      description: "sent: the request is pending (or was rejected, which the sender never sees); friends: you are friends now (they had asked you too, or you already were)",
    }),
  })
  .openapi("SendFriendRequestResponse");

export const ReceivedFriendRequestSchema = z
  .object({ user: FriendSchema, createdAt: epochMs("When the request was sent") })
  .openapi("ReceivedFriendRequest");

export const ReceivedFriendRequestsSchema = z
  .object({ requests: z.array(ReceivedFriendRequestSchema).openapi({ description: "Pending requests to you, most recent first" }) })
  .openapi("ReceivedFriendRequests");
