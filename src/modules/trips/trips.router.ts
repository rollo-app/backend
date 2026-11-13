import { createRoute } from "@hono/zod-openapi";
import { requireAdmin, requireTripMember, requireUser } from "../../lib/auth";
import { requireCreator } from "../../lib/creator";
import { bearerAuth, createApp, errors, json } from "../../lib/openapi";
import { rateLimit } from "../../lib/rate-limit";
import { MemberSchema, TripCreatedSchema, TripDetailSchema, TripParams, TripResponseSchema } from "../../schemas";
import * as controller from "./trips.controller";
import {
  AddMembersResponseSchema,
  AddMembersSchema,
  CoverSchema,
  CoverUploadRequestSchema,
  CoverUploadSchema,
  CreateTripSchema,
  GroupNameSchema,
  GroupParams,
  GroupSchema,
  JoinTripSchema,
  MyGroupsSchema,
  MyMembershipSchema,
  SetMyGroupsSchema,
  TripMemberParams,
  UpdateMyMembershipSchema,
  UpdateTripSchema,
} from "./trips.schemas";

const tags = ["Trips"];

export const createTripRoute = createRoute({
  method: "post",
  path: "/",
  tags,
  summary: "Create a trip",
  description: "Whoever creates it becomes the admin. The profile must have a name and a username. Returns the invite code. 409 at the limits on rollos you created (at most 2 unrevealed at once and 4 in the last 30 days; rollos you joined do not count; users with `users.unlimited_rollos` are exempt), with the message to show.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { body: { content: { "application/json": { schema: CreateTripSchema } }, required: true } },
  responses: { 201: json(TripCreatedSchema, "Trip created"), ...errors(400, 401, 409, 428) },
});

export const joinTripRoute = createRoute({
  method: "post",
  path: "/join",
  tags,
  summary: "Join a trip",
  description:
    "With the invite code. An event is joined choosing groups (`groupIds`, all from that event, else 400): without them 409 with `code` EVENT_NEEDS_UPDATE, " +
    "checked before anything else, even for an active member. The member and their groups are written together. The profile must have a name and a username. Idempotent: 201 when newly joined (or back after leaving), " +
    "200 when already an active member. Someone removed by the admin gets 403. Revealed rollos 409 ('Este evento ya se reveló.' for an event). A rollo that reached its member cap (`maxMembers`) also gets 409 with the numbers in the message (an active member still gets 200).",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { body: { content: { "application/json": { schema: JoinTripSchema } }, required: true } },
  responses: {
    201: json(TripCreatedSchema, "Joined the trip"),
    200: json(TripCreatedSchema, "Already a member"),
    ...errors(400, 401, 403, 404, 409, 428),
  },
});

export const getTripRoute = createRoute({
  method: "get",
  path: "/{tripId}",
  tags,
  summary: "Trip info",
  description: "Trip, members and how many photos and videos you have left today.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember] as const,
  request: { params: TripParams },
  responses: { 200: json(TripDetailSchema, "Trip detail"), ...errors(401, 403, 428) },
});

export const updateTripRoute = createRoute({
  method: "patch",
  path: "/{tripId}",
  tags,
  summary: "Edit the trip (admin)",
  description: "Any admin edits the name, dates, quota and daily moment, depending on the stage: before the start everything; while running not `startsAt` nor `photoLimitMode` (409); once ended or revealed only `name` (409 'El rollo ya terminó: no se puede editar'). A field re-sent with its stored value counts as untouched. Changing dates or moment config deletes the future moments nobody took (they are drawn again; today's stays). `featuringDisabled` (private rollo) is only for the creator: 403 without applying anything.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireAdmin] as const,
  request: {
    params: TripParams,
    body: { content: { "application/json": { schema: UpdateTripSchema } }, required: true },
  },
  responses: { 200: json(TripResponseSchema, "Trip updated"), ...errors(400, 401, 403, 409, 428) },
});

export const deleteTripRoute = createRoute({
  method: "delete",
  path: "/{tripId}",
  tags,
  summary: "Delete the rollo for everyone (creator)",
  description:
    "Only whoever created it (403 otherwise). Removes the rollo, its members, photos, likes, comments and featured photos at once; the files " +
    "in storage are purged later. Afterwards any route of that rollo answers 410 `{ error: \"Este rollo se borró\" }`. Cannot be undone.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireCreator] as const,
  request: { params: TripParams },
  responses: { 204: { description: "Rollo deleted" }, ...errors(401, 403, 410, 428) },
});

export const revealRoute = createRoute({
  method: "post",
  path: "/{tripId}/reveal",
  tags,
  summary: "Reveal the roll now (creator)",
  description: "Only whoever created the rollo.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireCreator] as const,
  request: { params: TripParams },
  responses: { 200: json(TripResponseSchema, "Roll revealed"), ...errors(401, 403, 428) },
});

export const addMembersRoute = createRoute({
  method: "post",
  path: "/{tripId}/members",
  tags,
  summary: "Add your friends to the trip",
  description:
    "Any member adds their own friends directly. The answer is per friend (never all-or-nothing): `added` (also when they " +
    "had left and come back), `already_member`, `unavailable` (not your friend, removed by the admin, or unknown) or `full` (no room left: the rollo has a cap on active members and friends are processed in request order). " +
    "An event refuses it (409): guests enter with the code. " +
    "The rollo's admin can add back someone who was removed (they become active again with their old photos); " +
    "for a regular member a removed person stays `unavailable`. A revealed rollo gets 409 for the whole request.",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_EXPENSIVE"), requireTripMember] as const,
  request: {
    params: TripParams,
    body: { content: { "application/json": { schema: AddMembersSchema } }, required: true },
  },
  responses: { 200: json(AddMembersResponseSchema, "Result per friend"), ...errors(400, 401, 403, 409, 428, 429) },
});

export const setMyGroupsRoute = createRoute({
  method: "put",
  path: "/{tripId}/members/me/groups",
  tags,
  summary: "Set your groups in an event",
  description:
    "Replaces the groups you are in (all must belong to the event, else 400). A guest needs at least one (400 with `[]`); an organizer (admin) may have none. 409 for a regular trip and once the event is revealed ('Este evento ya se reveló.').",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember] as const,
  request: { params: TripParams, body: { content: { "application/json": { schema: SetMyGroupsSchema } }, required: true } },
  responses: { 200: json(MyGroupsSchema, "Your groups"), ...errors(400, 401, 403, 409, 428) },
});

export const leaveRoute = createRoute({
  method: "delete",
  path: "/{tripId}/members/me",
  tags,
  summary: "Leave the trip",
  description:
    "You lose access and the rollo leaves your list; your photos stay in the roll. You can come back with the code or " +
    "if a friend adds you (before the reveal). Any admin can leave and comes back as a regular member; the creator can't (409).",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember] as const,
  request: { params: TripParams },
  responses: { 204: { description: "You left the trip" }, ...errors(401, 403, 409, 428) },
});

export const updateMyMembershipRoute = createRoute({
  method: "patch",
  path: "/{tripId}/members/me",
  tags,
  summary: "Your settings in this rollo",
  description:
    "`allowFeaturing`: whether others may feature your photos of this rollo on their profile (on by default). " +
    "Turning it off removes them from other profiles; turning it on restores nothing. " +
    "`archived`: archive or unarchive the rollo for you only (409 if it is not revealed). Send at least one field.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember] as const,
  request: {
    params: TripParams,
    body: { content: { "application/json": { schema: UpdateMyMembershipSchema } }, required: true },
  },
  responses: { 200: json(MyMembershipSchema, "Updated"), ...errors(400, 401, 403, 409, 428) },
});

export const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{tripId}/members/{memberId}",
  tags,
  summary: "Remove someone from the trip (admin)",
  description: "Admins remove regular members; only the creator removes other admins; nobody removes the creator (403). They lose access to the rollo and cannot rejoin by code or through a regular member; only the admin can add them back as a friend. Their photos stay in the roll.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireAdmin] as const,
  request: { params: TripMemberParams },
  responses: { 204: { description: "Member removed" }, ...errors(400, 401, 403, 404, 428) },
});

export const makeAdminRoute = createRoute({
  method: "post",
  path: "/{tripId}/members/{memberId}/admin",
  tags,
  summary: "Make a member admin (admin)",
  description: "Any admin can. The target must be an active member (404 otherwise); if they are already admin it still answers 200.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireAdmin] as const,
  request: { params: TripMemberParams },
  responses: { 200: json(MemberSchema, "The member, now admin"), ...errors(401, 403, 404, 428) },
});

export const removeAdminRoute = createRoute({
  method: "delete",
  path: "/{tripId}/members/{memberId}/admin",
  tags,
  summary: "Take the admin role away (creator)",
  description: "Only the creator. The creator's own admin role can't be removed (400).",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireCreator] as const,
  request: { params: TripMemberParams },
  responses: { 200: json(MemberSchema, "The member, now a regular member"), ...errors(400, 401, 403, 404, 428) },
});

const FROZEN = "409 for a regular trip and once the event is revealed ('Este evento ya se reveló.'). ";

export const createGroupRoute = createRoute({
  method: "post",
  path: "/{tripId}/groups",
  tags,
  summary: "Create a group in an event (admin)",
  description: `The name is trimmed (1 to 40 characters) and unique in the event (409). At most 30 groups (409). ${FROZEN}`,
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireAdmin] as const,
  request: { params: TripParams, body: { content: { "application/json": { schema: GroupNameSchema } }, required: true } },
  responses: { 201: json(GroupSchema, "Group created"), ...errors(400, 401, 403, 409, 428) },
});

export const renameGroupRoute = createRoute({
  method: "patch",
  path: "/{tripId}/groups/{groupId}",
  tags,
  summary: "Rename a group of an event (admin)",
  description: `Same name rules as creating one (409 if taken). 404 if the group is not in this event. ${FROZEN}`,
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireAdmin] as const,
  request: { params: GroupParams, body: { content: { "application/json": { schema: GroupNameSchema } }, required: true } },
  responses: { 200: json(GroupSchema, "Group renamed"), ...errors(400, 401, 403, 404, 409, 428) },
});

export const deleteGroupRoute = createRoute({
  method: "delete",
  path: "/{tripId}/groups/{groupId}",
  tags,
  summary: "Delete a group of an event (admin)",
  description: `409 ('Este grupo tiene gente o fotos.') while anyone is in the group or any photo was sent to it. 404 if the group is not in this event. ${FROZEN}`,
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireAdmin] as const,
  request: { params: GroupParams },
  responses: { 204: { description: "Group deleted" }, ...errors(401, 403, 404, 409, 428) },
});

export const requestCoverRoute = createRoute({
  method: "post",
  path: "/{tripId}/cover",
  tags,
  summary: "Get a URL to upload the event cover (admin)",
  description:
    "Send the exact byte size of the JPEG (`sizeBytes`, max 2 MB; 400 otherwise). Returns a URL signed for exactly that Content-Length to PUT the JPEG straight to R2. Then call POST /trips/{tripId}/cover/complete. " +
    "409 for a regular trip. 503 when the storage limit is reached. A previous upload that was never completed is discarded.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireAdmin, rateLimit("RL_EXPENSIVE")] as const,
  request: { params: TripParams, body: { content: { "application/json": { schema: CoverUploadRequestSchema } }, required: true } },
  responses: { 200: json(CoverUploadSchema, "Upload URL"), ...errors(400, 401, 403, 409, 428, 429, 503) },
});

export const completeCoverRoute = createRoute({
  method: "post",
  path: "/{tripId}/cover/complete",
  tags,
  summary: "Confirm the event cover upload (admin)",
  description:
    "Checks that the file is in R2, is a JPEG (verified by its magic bytes) and is at most 2 MB, makes it the event's cover and deletes the previous one. " +
    "Otherwise the upload is discarded and the response is a 400. The cover is served publicly at `coverUrl` (GET /covers/{tripId}/{file}).",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireAdmin, rateLimit("RL_EXPENSIVE")] as const,
  request: { params: TripParams },
  responses: { 200: json(CoverSchema, "The new cover"), ...errors(400, 401, 403, 409, 428, 429) },
});

const trips = createApp();

trips.openapi(createTripRoute, controller.create);
trips.openapi(joinTripRoute, controller.join);
trips.openapi(getTripRoute, controller.detail);
trips.openapi(deleteTripRoute, controller.remove);
trips.openapi(updateTripRoute, controller.update);
trips.openapi(revealRoute, controller.reveal);
trips.openapi(addMembersRoute, controller.addMembers);
trips.openapi(updateMyMembershipRoute, controller.updateMyMembership);
trips.openapi(setMyGroupsRoute, controller.setMyGroups);
trips.openapi(createGroupRoute, controller.createGroup);
trips.openapi(renameGroupRoute, controller.renameGroup);
trips.openapi(deleteGroupRoute, controller.deleteGroup);
trips.openapi(requestCoverRoute, controller.requestCover);
trips.openapi(completeCoverRoute, controller.completeCover);
trips.openapi(leaveRoute, controller.leave);
trips.openapi(removeMemberRoute, controller.removeMember);
trips.openapi(makeAdminRoute, controller.makeAdmin);
trips.openapi(removeAdminRoute, controller.removeAdmin);

export default trips;
