import { z } from "@hono/zod-openapi";
import { FriendSchema } from "../../schemas";

export const BlocksSchema = z.object({ blocked: z.array(FriendSchema) }).openapi("Blocks");
