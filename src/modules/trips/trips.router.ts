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
  CreateTripSchema,
  JoinTripSchema,
  MyMembershipSchema,
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
  responses: { 201: json(TripCreatedSchema, "Trip created"), ...errors(400, 401, 409) },
});

export const joinTripRoute = createRoute({
  method: "post",
  path: "/join",
  tags,
  summary: "Join a trip",
  description:
    "With the invite code. The profile must have a name and a username. Idempotent: 201 when newly joined (or back after leaving), " +
    "200 when already an active member. Someone removed by the admin gets 403. Revealed rollos 409.",
  security: bearerAuth,
  middleware: [requireUser] as const,
  request: { body: { content: { "application/json": { schema: JoinTripSchema } }, required: true } },
  responses: {
    201: json(TripCreatedSchema, "Joined the trip"),
    200: json(TripCreatedSchema, "Already a member"),
    ...errors(400, 401, 403, 404, 409),
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
  responses: { 200: json(TripDetailSchema, "Trip detail"), ...errors(401, 403) },
});

export const updateTripRoute = createRoute({
  method: "patch",
  path: "/{tripId}",
  tags,
  summary: "Edit the trip (admin)",
  description: "Any admin can rename the rollo (`name`). Everything else (dates, limits, private rollo) is only for the creator: 403 without applying anything if the body has more than `name`.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember, requireAdmin] as const,
  request: {
    params: TripParams,
    body: { content: { "application/json": { schema: UpdateTripSchema } }, required: true },
  },
  responses: { 200: json(TripResponseSchema, "Trip updated"), ...errors(400, 401, 403) },
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
  responses: { 200: json(TripResponseSchema, "Roll revealed"), ...errors(401, 403) },
});

export const addMembersRoute = createRoute({
  method: "post",
  path: "/{tripId}/members",
  tags,
  summary: "Add your friends to the trip",
  description:
    "Any member adds their own friends directly. The answer is per friend (never all-or-nothing): `added` (also when they " +
    "had left and come back), `already_member`, or `unavailable` (not your friend, removed by the admin, or unknown). " +
    "The rollo's admin can add back someone who was removed (they become active again with their old photos); " +
    "for a regular member a removed person stays `unavailable`. A revealed rollo gets 409 for the whole request.",
  security: bearerAuth,
  middleware: [requireUser, rateLimit("RL_EXPENSIVE"), requireTripMember] as const,
  request: {
    params: TripParams,
    body: { content: { "application/json": { schema: AddMembersSchema } }, required: true },
  },
  responses: { 200: json(AddMembersResponseSchema, "Result per friend"), ...errors(400, 401, 403, 409, 429) },
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
  responses: { 204: { description: "You left the trip" }, ...errors(401, 403, 409) },
});

export const updateMyMembershipRoute = createRoute({
  method: "patch",
  path: "/{tripId}/members/me",
  tags,
  summary: "Your settings in this rollo",
  description:
    "`allowFeaturing`: whether others may feature your photos of this rollo on their profile (on by default). " +
    "Turning it off removes them from other profiles; turning it on restores nothing.",
  security: bearerAuth,
  middleware: [requireUser, requireTripMember] as const,
  request: {
    params: TripParams,
    body: { content: { "application/json": { schema: UpdateMyMembershipSchema } }, required: true },
  },
  responses: { 200: json(MyMembershipSchema, "Updated"), ...errors(400, 401, 403) },
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
  responses: { 204: { description: "Member removed" }, ...errors(400, 401, 403, 404) },
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
  responses: { 200: json(MemberSchema, "The member, now admin"), ...errors(401, 403, 404) },
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
  responses: { 200: json(MemberSchema, "The member, now a regular member"), ...errors(400, 401, 403, 404) },
});

const trips = createApp();

trips.openapi(createTripRoute, controller.create);
trips.openapi(joinTripRoute, controller.join);
trips.openapi(getTripRoute, controller.detail);
trips.openapi(updateTripRoute, controller.update);
trips.openapi(revealRoute, controller.reveal);
trips.openapi(addMembersRoute, controller.addMembers);
trips.openapi(updateMyMembershipRoute, controller.updateMyMembership);
trips.openapi(leaveRoute, controller.leave);
trips.openapi(removeMemberRoute, controller.removeMember);
trips.openapi(makeAdminRoute, controller.makeAdmin);
trips.openapi(removeAdminRoute, controller.removeAdmin);

export default trips;
