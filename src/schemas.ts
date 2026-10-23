import { z } from "@hono/zod-openapi";
import { isValidUsername, normalizeUsername, USERNAME_INVALID_MESSAGE } from "./lib/username";
import { isBase64, isEmail, isValidTimeZone } from "./lib/util";

/**
 * API contract. These schemas validate requests, type responses
 * and generate /openapi.json, from which the mobile app generates its client.
 */

const epochMs = (description: string) => z.number().int().positive().openapi({ description, example: 1_767_225_600_000 });
const nullableNumber = z.number().nullable();

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
    dailyVideoLimit: z.number().int(),
  })
  .openapi("Trip");

export const ProfileVisibilitySchema = z.enum(["friends", "public"]).openapi("ProfileVisibility", {
  description: "Who can see your bio and featured photos: your friends only, or anyone signed in. Name, username and avatar are always visible",
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
    blockedByMe: z.boolean().openapi({ description: "Whether you blocked this member" }),
  })
  .openapi("Member");

// ---------- Auth ----------

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isEmail, "Ingresá un email válido")
  .openapi({ example: "juani@example.com", description: "Trimmed and lowercased" });

export const EmailStartSchema = z.object({ email: emailField }).openapi("EmailStartRequest");

export const EmailVerifySchema = z
  .object({ email: emailField, code: z
      .string()
      .trim()
      .max(16)
      .openapi({
        example: "K7M2QX",
        description:
          "6-character code from the email (letters and digits, no 0/O/1/I/L). Case-insensitive; spaces and dashes are ignored",
      }) })
  .openapi("EmailVerifyRequest");

export const AuthSessionSchema = z
  .object({
    token: z.string().openapi({ description: "Session token (Bearer). Valid for 365 days; store it on the phone" }),
    user: UserSchema,
    isNew: z.boolean().openapi({ description: "true while the profile is incomplete (no name or no username): show the profile step" }),
  })
  .openapi("AuthSession");

// ---------- Trips ----------

const personName = z.string().trim().min(1).max(30).openapi({ example: "Juani" });

/** Clock-skew tolerance when validating that a date is not in the past. */
export const PAST_TOLERANCE_MS = 5 * 60_000;

export const CreateTripSchema = z
  .object({
    name: z.string().trim().min(1).max(60).openapi({ example: "Viaje al sur" }),
    timezone: z
      .string()
      .refine(isValidTimeZone, "Zona horaria inválida")
      .openapi({ example: "America/Argentina/Buenos_Aires", description: "IANA time zone of the destination" }),
    startsAt: epochMs("Trip start"),
    endsAt: epochMs("Trip end; must be after startsAt"),
    revealAt: epochMs("When the roll is revealed; must be >= endsAt"),
    dailyPhotoLimit: z.number().int().min(1).max(100).default(10),
    dailyVideoLimit: z.number().int().min(0).max(20).default(3),
  })
  .refine((d) => d.startsAt >= Date.now() - PAST_TOLERANCE_MS, { message: "El inicio no puede ser en el pasado", path: ["startsAt"] })
  .refine((d) => d.endsAt > d.startsAt, { message: "El rollo tiene que terminar después de empezar", path: ["endsAt"] })
  .refine((d) => d.revealAt >= d.endsAt, { message: "El revelado no puede ser antes del fin", path: ["revealAt"] })
  .openapi("CreateTripRequest");

export const JoinTripSchema = z
  .object({
    code: z.string().trim().toUpperCase().length(6).openapi({ example: "HUB5FT" }),
  })
  .openapi("JoinTripRequest");

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

export const UsernameParams = z.object({
  username: z.string().openapi({ param: { name: "username", in: "path" }, example: "juanifraga" }),
});

export const UsernameAvailabilitySchema = z
  .object({
    available: z.boolean().openapi({ description: "true if nobody else has it (also true if it is yours)" }),
    username: z.string().openapi({ description: "The normalized username that was checked" }),
  })
  .openapi("UsernameAvailability");

export const UpdateTripSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    endsAt: z.number().int().positive().optional().openapi({ description: "Trip end; must be after startsAt and <= the resulting revealAt" }),
    revealAt: z.number().int().positive().optional().openapi({ description: "Must be >= the resulting endsAt" }),
    dailyPhotoLimit: z.number().int().min(1).max(100).optional(),
    dailyVideoLimit: z.number().int().min(0).max(20).optional(),
  })
  .openapi("UpdateTripRequest");

export const TripCreatedSchema = z
  .object({
    trip: TripSchema,
    member: MemberSchema,
  })
  .openapi("TripCreated");

export const TripSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    joinCode: z.string(),
    startsAt: epochMs("Trip start"),
    endsAt: epochMs("Trip end"),
    revealAt: epochMs("Automatic reveal"),
    revealed: z.boolean(),
    role: RoleSchema,
    totalUploaded: z.number().int(),
    coverThumbhash: z.string().nullable().openapi({
      description:
        "ThumbHash of the most recently taken uploaded photo or video of the rollo (null if none); the app derives the rollo's color from it",
    }),
  })
  .openapi("TripSummary");

export const AvatarUploadSchema = z
  .object({
    upload: z.string().url().openapi({ description: "PUT of the JPEG avatar (square, ~512px)" }),
    expiresIn: z.number().int().openapi({ description: "Seconds the URL stays valid" }),
  })
  .openapi("AvatarUpload");

export const AvatarParams = z.object({
  userId: z.string().openapi({ param: { name: "userId", in: "path" } }),
  file: z.string().openapi({ param: { name: "file", in: "path" }, example: "3f1c2a.jpg" }),
});

// ---------- Push tokens and settings ----------

/** Expo push token as returned by getExpoPushTokenAsync. */
export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/;

export const PushTokenParams = z.object({
  token: z
    .string()
    .max(200, "El token de notificaciones no es válido")
    .regex(EXPO_PUSH_TOKEN, "El token de notificaciones no es válido")
    .openapi({ param: { name: "token", in: "path" }, example: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]" }),
});

export const NotificationSettingsSchema = z
  .object({
    addedToTrip: z.boolean().openapi({ description: "Someone adds you to a rollo" }),
    newFriend: z.boolean().openapi({ description: "Someone redeems your friend link" }),
    tripStarted: z.boolean().openapi({ description: "A rollo you are in starts" }),
    tripRevealed: z.boolean().openapi({ description: "A rollo you are in is revealed" }),
    photoFeatured: z.boolean().openapi({ description: "Someone features a photo of yours on their profile" }),
    photoLiked: z.boolean().openapi({ description: "Someone likes a photo of yours" }),
  })
  .openapi("NotificationSettings");

export const UserSettingsSchema = z.object({ notifications: NotificationSettingsSchema }).openapi("UserSettings");

export const UpdateUserSettingsSchema = z
  .strictObject({ notifications: NotificationSettingsSchema.partial().strict().optional() })
  .openapi("UpdateUserSettingsRequest");

export const MyTripsSchema = z.object({ trips: z.array(TripSummarySchema) }).openapi("MyTrips");

export const TripDetailSchema = z
  .object({
    trip: TripSchema,
    me: MemberSchema,
    members: z.array(MemberSchema),
    today: z.object({
      date: z.string().openapi({ example: "2027-01-12", description: "Trip's local date" }),
      photosLeft: z.number().int().openapi({ description: "0 outside the rollo's dates" }),
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

export const FriendsSchema = z.object({ friends: z.array(FriendSchema) }).openapi("Friends");

export const BlocksSchema = z.object({ blocked: z.array(FriendSchema) }).openapi("Blocks");

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

export const ReportReasonSchema = z.enum(["offensive", "abuse", "other"]).openapi("ReportReason");

export const CreateReportSchema = z
  .object({
    reason: ReportReasonSchema,
    mediaId: z.string().trim().min(1).max(64).optional().openapi({ description: "Photo or video to report" }),
    userId: z.string().trim().min(1).max(64).optional().openapi({ description: "Person to report" }),
  })
  .refine((b) => (b.mediaId !== undefined) !== (b.userId !== undefined), "Mandá la foto o la persona, no las dos")
  .openapi("CreateReportRequest");

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

// ---------- Users ----------

export const UserParams = z.object({
  userId: z.string().openapi({ param: { name: "userId", in: "path" } }),
});

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

export const AddMembersSchema = z
  .object({
    friendIds: z.array(z.string().min(1).max(64)).min(1).max(50).openapi({ description: "User ids of your friends (1 to 50)" }),
  })
  .openapi("AddMembersRequest");

export const AddMembersResponseSchema = z
  .object({
    results: z.array(
      z.object({
        userId: z.string(),
        status: z.enum(["added", "already_member", "unavailable"]).openapi({
          description:
            "added: now a member (also if they had left); already_member; unavailable: not your friend, removed by the admin (unless the caller is the admin), or unknown",
        }),
      }),
    ),
  })
  .openapi("AddMembersResponse");

export const FriendParams = z.object({
  userId: z.string().openapi({ param: { name: "userId", in: "path" } }),
});

// ---------- Media ----------

export const MAX_VIDEO_SECONDS = 15.5; // 15 s + rounding margin
const MB = 1024 * 1024;
export const MAX_SIZE = { photo: 25 * MB, video: 60 * MB } as const;

export const RegisterMediaSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "UUID generated on the phone; retrying with the same id is safe" }),
    type: MediaTypeSchema,
    takenAt: epochMs("Phone time when the shot was taken"),
    lat: z.number().min(-90).max(90).nullish(),
    lng: z.number().min(-180).max(180).nullish(),
    accuracyM: z.number().nonnegative().nullish(),
    caption: z.string().trim().max(280).nullish(),
    thumbhash: z
      .string()
      .max(64)
      .refine(isBase64, "El thumbhash tiene que ser base64")
      .nullish()
      .openapi({
        description:
          "ThumbHash (https://evanw.github.io/thumbhash/) in standard base64, generated on the phone from the thumbnail. " +
          "If a retry brings a different value, the first one is kept.",
        example: "3OcRJYB4d3h/iIeHeEh3eIhw+j3A",
      }),
    durationS: z.number().positive().nullish(),
    width: z.number().int().positive().nullish(),
    height: z.number().int().positive().nullish(),
    sizeBytes: z.number().int().positive(),
  })
  .refine((d) => d.type !== "video" || (d.durationS != null && d.durationS <= MAX_VIDEO_SECONDS), {
    message: "Los videos tienen que durar 15 segundos o menos",
    path: ["durationS"],
  })
  .refine((d) => d.sizeBytes <= MAX_SIZE[d.type], { message: "El archivo es demasiado grande", path: ["sizeBytes"] })
  .openapi("RegisterMediaRequest");

export const MediaRegisteredSchema = z
  .object({
    id: z.string().uuid(),
    status: z.literal("pending"),
    upload: z.object({
      original: z.string().url().openapi({ description: "PUT of the original file" }),
      thumb: z.string().url().openapi({ description: "PUT of the JPEG thumbnail (~800px)" }),
    }),
    expiresIn: z.number().int().openapi({ description: "Seconds the URLs stay valid" }),
  })
  .openapi("MediaRegistered");

export const MediaStatusSchema = z
  .object({ id: z.string().uuid(), status: z.literal("uploaded") })
  .openapi("MediaStatus");

export const FeedItemSchema = z
  .object({
    id: z.string().uuid(),
    type: MediaTypeSchema,
    takenAt: z.number().int(),
    day: z.string().openapi({ example: "2027-01-12" }),
    lat: nullableNumber,
    lng: nullableNumber,
    caption: z.string().nullable(),
    thumbhash: z.string().nullable().openapi({
      description:
        "ThumbHash in base64. Always returned, also before the reveal, on purpose: " +
        "it only encodes blurry colors (~25 bytes), the photo cannot be reconstructed from it.",
    }),
    durationS: nullableNumber,
    author: z
      .object({
        id: z.string().uuid(),
        userId: z.string().uuid().openapi({ description: "The author's user id (to open their profile)" }),
        name: z.string(),
        username: z.string().nullable(),
        avatarUrl: z.string().nullable(),
      })
      .openapi({ description: "`id` is the author's membership id; `userId` their user id" }),
    width: nullableNumber.optional().openapi({ description: "Only after the reveal" }),
    height: nullableNumber.optional().openapi({ description: "Only after the reveal" }),
    files: z
      .object({ thumb: z.string(), original: z.string() })
      .optional()
      .openapi({ description: "Download paths; only after the reveal" }),
    featuredByMe: z.boolean().optional().openapi({ description: "Only after the reveal: you featured it on your profile" }),
    featureBlocked: z.boolean().optional().openapi({
      description: "Only after the reveal: the author does not let others feature it (they still can)",
    }),
    likeCount: z.number().int().optional().openapi({
      description: "Only after the reveal: how many people like it (one counter, also likes from profiles that feature it). Always 0 for videos",
    }),
    likedByMe: z.boolean().optional().openapi({ description: "Only after the reveal: you like it" }),
  })
  .openapi("FeedItem");

export const FeedResponseSchema = z
  .object({
    revealed: z.boolean(),
    revealAt: z.number().int(),
    items: z.array(FeedItemSchema),
  })
  .openapi("Feed");

// ---------- Featured photos ----------

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

// ---------- Path params ----------

const pathParam = (name: string) => z.string().openapi({ param: { name, in: "path" } });

export const TripParams = z.object({ tripId: pathParam("tripId") });
export const TripMemberParams = z.object({ tripId: pathParam("tripId"), memberId: pathParam("memberId") });
export const MediaParams = z.object({ mediaId: pathParam("mediaId") });
export const MediaFileParams = z.object({
  tripId: pathParam("tripId"),
  mediaId: pathParam("mediaId"),
  variant: z.enum(["thumb", "original"]).openapi({ param: { name: "variant", in: "path" } }),
});
export const FeaturedFileParams = z.object({
  userId: pathParam("userId"),
  mediaId: pathParam("mediaId"),
  variant: z.enum(["thumb", "original"]).openapi({ param: { name: "variant", in: "path" } }),
});
