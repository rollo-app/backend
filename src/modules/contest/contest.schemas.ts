import { z } from "@hono/zod-openapi";
import { pathParam } from "../../schemas";

export const FinalistParams = z.object({ tripId: pathParam("tripId"), mediaId: pathParam("mediaId") });

const AuthorSchema = z
  .object({ userId: z.string(), name: z.string(), avatarUrl: z.string().nullable() })
  .openapi("ContestAuthor");

export const FinalistSchema = z
  .object({
    mediaId: z.string(),
    author: AuthorSchema,
    thumbHash: z.string().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    thumbPath: z.string().openapi({ description: "Path of the thumbnail, served by the contest's own route." }),
    displayPath: z.string().openapi({ description: "Path of the display image, served by the contest's own route." }),
    votes: z.number().int().nullable().openapi({ description: "Null until the contest is closed; never shown while voting." }),
  })
  .openapi("ContestFinalist");

export const ContestSchema = z
  .object({
    status: z.enum(["pending", "selecting", "voting", "closing", "tied", "closed", "cancelled"]),
    votingHours: z.number().int(),
    closesAt: z.number().int().nullable().openapi({ description: "When voting ends (epoch ms); null if cancelled." }),
    finalists: z.array(FinalistSchema),
    myVote: z.string().nullable(),
    winner: z.object({ mediaId: z.string(), author: AuthorSchema, imageAvailable: z.boolean() }).nullable(),
    tiedMediaIds: z.array(z.string()).openapi({ description: "Only for organizers while `tied`: the finalists sharing the top vote count. Empty otherwise." }),
  })
  .openapi("Contest");
