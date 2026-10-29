import { z } from "@hono/zod-openapi";
import { isValidUsername, normalizeUsername, USERNAME_INVALID_MESSAGE } from "./lib/username";
import { isEmail } from "./lib/util";

/**
 * API contract. These schemas validate requests, type responses
 * and generate /openapi.json, from which the mobile app generates its client.
 */

export const epochMs = (description: string) => z.number().int().positive().openapi({ description, example: 1_767_225_600_000 });
export const nullableNumber = z.number().nullable();

// ---------- Common ----------

export const ErrorSchema = z
  .object({ error: z.string().openapi({ example: "Código inválido" }) })
  .openapi("Error");

export const RoleSchema = z.enum(["admin", "member"]).openapi("Role");
export const MediaTypeSchema = z.enum(["photo", "video"]).openapi("MediaType");

export const TripSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().openapi({ example: "Viaje al sur" }),
    joinCode: z.string().openapi({ example: "HUB5FT", description: "6-character code to join" }),
    timezone: z.string().openapi({ example: "America/Argentina/Buenos_Aires" }),
    startsAt: epochMs("Trip start"),
    endsAt: epochMs("Trip end"),
    revealAt: epochMs("Automatic reveal"),
    revealed: z.boolean(),
    dailyPhotoLimit: z.number().int(),
    dailyVideoLimit: z.number().int().openapi({ description: "Legacy: new rollos have no videos (0)" }),
    featuringDisabled: z.boolean().openapi({ description: "Private rollo: nobody can feature its photos on a profile, not even their author" }),
    photoLimitMode: z.enum(["daily", "total"]).openapi({
      description: "daily: dailyPhotoLimit per person per local day; total: totalPhotoLimit per person for the whole rollo",
    }),
    totalPhotoLimit: z.number().int().nullable().openapi({ description: "Photos per person in the whole rollo; null in daily mode" }),
    momentMode: z.enum(["off", "photo", "photo_selfie"]).openapi({ description: "Daily moment: off, a photo, or a photo plus a selfie" }),
    momentWindowStart: z.number().int().openapi({ description: "Moment window start, minutes from midnight in the rollo's time zone" }),
    momentWindowEnd: z.number().int().openapi({ description: "Moment window end, minutes from midnight in the rollo's time zone" }),
    createdBy: z
      .object({ userId: z.string().uuid(), name: z.string() })
      .nullable()
      .openapi({ description: "Who created the rollo (always an admin). Only filled in by GET /trips/{tripId}, create, join and the edit routes; null if unknown" }),
  })
  .openapi("Trip");

export const ProfileVisibilitySchema = z.enum(["friends", "public"]).openapi("ProfileVisibility", {
  description: "Who can see your bio and featured photos: your friends only, or anyone signed in. Name, username and avatar are always visible",
});

export const UserBadgeSchema = z.enum(["founder", "first_edition"]).nullable().openapi({
  description: "Profile badge assigned by hand (founder = Founder, first_edition = First Edition); null if none",
});

export const UserSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().openapi({ example: "juani@example.com" }),
    name: z.string().nullable().openapi({ description: "null until the profile is completed" }),
    username: z.string().nullable().openapi({
      example: "juanifraga",
      description: "Unique handle, lowercase, without the @ (the app shows it as @username); null until chosen",
    }),
    avatarUrl: z.string().nullable().openapi({
      description: "Path (the app prefixes the API base URL), e.g. /avatars/<userId>/<version>.jpg; null if none",
    }),
    bio: z.string().nullable().openapi({ example: "Viajando por el sur", description: "Profile description (up to 3 lines); null if none" }),
    badge: UserBadgeSchema,
    profileVisibility: ProfileVisibilitySchema,
  })
  .openapi("User");

export const MemberSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Membership id (the one used by DELETE members and FeedItem.author)" }),
    userId: z.string().uuid(),
    name: z.string().openapi({ example: "Fede" }),
    username: z.string().nullable().openapi({ example: "fede", description: "Unique handle without the @" }),
    avatarUrl: z.string().nullable(),
    role: RoleSchema,
    isCreator: z.boolean().openapi({ description: "Created the rollo: always an admin, can't leave and can't be removed" }),
    blockedByMe: z.boolean().openapi({ description: "Whether you blocked this member" }),
    allowFeaturing: z.boolean().optional().openapi({ description: "Only on `me`: others may feature your photos of this rollo on their profile" }),
  })
  .openapi("Member");

// ---------- Auth ----------

export const AuthSessionSchema = z
  .object({
    token: z.string().openapi({ description: "Session token (Bearer). Valid for 365 days; store it on the phone" }),
    user: UserSchema,
    isNew: z.boolean().openapi({ description: "true while the profile is incomplete (no name or no username): show the profile step" }),
  })
  .openapi("AuthSession");

// ---------- Trips ----------

export const personName = z.string().trim().min(1).max(30).openapi({ example: "Juani" });

/** Clock-skew tolerance when validating that a date is not in the past. */
export const PAST_TOLERANCE_MS = 5 * 60_000;

/** Accepts it with or without "@" and any case; the parsed value is the normalized one. */
export const usernameField = z
  .string()
  .transform(normalizeUsername)
  .refine(isValidUsername, USERNAME_INVALID_MESSAGE)
  .openapi({
    type: "string",
    example: "juanifraga",
    description: "Optional leading @, trimmed and lowercased. a-z 0-9 . _ (3 to 30), no leading/trailing dot, no \"..\"",
  });

export const BIO_MAX_LENGTH = 150;
export const BIO_MAX_LINES = 3;

/** Trimmed; an empty bio is stored as null. A CRLF (or a lone CR) counts as one line break. */
export const bioField = z
  .string()
  .trim()
  .refine((s) => s.length <= BIO_MAX_LENGTH, `La descripción puede tener hasta ${BIO_MAX_LENGTH} caracteres`)
  .refine((s) => s.split(/\r\n|\r|\n/).length <= BIO_MAX_LINES, `La descripción puede tener hasta ${BIO_MAX_LINES} renglones`)
  .transform((s) => (s === "" ? null : s))
  .openapi({
    type: "string",
    example: "Viajando por el sur",
    description: `Profile description, up to ${BIO_MAX_LENGTH} characters and ${BIO_MAX_LINES} lines after trimming. An empty string clears it`,
  });

export const UpdateProfileSchema = z
  .object({
    name: personName.optional(),
    username: usernameField.optional(),
    bio: bioField.optional(),
    profileVisibility: ProfileVisibilitySchema.optional(),
  })
  .openapi("UpdateProfileRequest");


export const TripCreatedSchema = z
  .object({
    trip: TripSchema,
    member: MemberSchema,
  })
  .openapi("TripCreated");

export const TripDetailSchema = z
  .object({
    trip: TripSchema,
    me: MemberSchema,
    members: z.array(MemberSchema),
    today: z.object({
      date: z.string().openapi({ example: "2027-01-12", description: "Trip's local date" }),
      photosLeft: z.number().int().openapi({
        description: "Photos left today (daily mode) or in the whole rollo (total mode); 0 outside the rollo's dates",
      }),
      videosLeft: z.number().int().openapi({ description: "0 outside the rollo's dates" }),
    }),
    totalUploaded: z.number().int(),
  })
  .openapi("TripDetail");

export const TripResponseSchema = z.object({ trip: TripSchema }).openapi("TripResponse");

// ---------- Friends ----------

export const FriendSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "User id" }),
    name: z.string().openapi({ example: "Cami" }),
    username: z.string().nullable().openapi({ example: "cami", description: "Unique handle without the @" }),
    avatarUrl: z.string().nullable(),
    bio: z.string().nullable().openapi({ example: "Viajando por el sur", description: "Profile description (up to 3 lines); null if none" }),
  })
  .openapi("Friend");


// ---------- Users ----------

export const UserParams = z.object({
  userId: z.string().openapi({ param: { name: "userId", in: "path" } }),
});


export const FriendParams = z.object({
  userId: z.string().openapi({ param: { name: "userId", in: "path" } }),
});

// ---------- Path params ----------

export const pathParam = (name: string) => z.string().openapi({ param: { name, in: "path" } });

export const TripParams = z.object({ tripId: pathParam("tripId") });
export const MediaParams = z.object({ mediaId: pathParam("mediaId") });
