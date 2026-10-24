import { z } from "@hono/zod-openapi";
import { nullableNumber, pathParam } from "../../schemas";

export const MAX_FEATURED = 60;

export const ZoneSchema = z
  .object({ lat: z.number(), lng: z.number() })
  .openapi("Zone", {
    description: "Center of the ~5 km cell (0.05°) where the photo was taken. Never the exact coordinates",
    example: { lat: -41.075, lng: -71.475 },
  });

export const FeaturedPhotoSchema = z
  .object({
    mediaId: z.string().uuid(),
    takenAt: z.number().int(),
    width: nullableNumber,
    height: nullableNumber,
    thumbhash: z.string().nullable(),
    author: z
      .object({
        id: z.string().uuid().openapi({ description: "User id" }),
        name: z.string(),
        username: z.string().nullable(),
        avatarUrl: z.string().nullable(),
      })
      .nullable()
      .openapi({ description: "Who took it; null when it is the profile owner" }),
    zone: ZoneSchema.nullable().openapi({ description: "null if the photo has no GPS" }),
    thumbPath: z.string().openapi({ example: "/featured/<userId>/<mediaId>/thumb" }),
    originalPath: z.string().openapi({ example: "/featured/<userId>/<mediaId>/original" }),
    likeCount: z.number().int().openapi({ description: "How many people like it (the same counter as in its rollo)" }),
    likedByMe: z.boolean().openapi({ description: "You like it" }),
  })
  .openapi("FeaturedPhoto", {
    description: "A photo on someone's profile. Never includes the rollo, the caption or the exact location",
  });

export const FeaturedPhotosSchema = z
  .object({ photos: z.array(FeaturedPhotoSchema).openapi({ description: "Most recently featured first" }) })
  .openapi("FeaturedPhotos");

export const FeaturedFileParams = z.object({
  userId: pathParam("userId"),
  mediaId: pathParam("mediaId"),
  variant: z.enum(["thumb", "original"]).openapi({ param: { name: "variant", in: "path" } }),
});
