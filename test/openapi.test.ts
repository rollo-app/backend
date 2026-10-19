import { describe, expect, it } from "vitest";
import {
  ErrorSchema,
  FeedResponseSchema,
  MediaRegisteredSchema,
  MediaStatusSchema,
  TripCreatedSchema,
  TripDetailSchema,
  TripResponseSchema,
} from "../src/schemas";
import { api, createTrip, join, photoBody, uploadMedia } from "./helpers";

type OpenAPIDoc = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, { security?: unknown[]; responses: Record<string, unknown> }>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, { type: string; scheme: string }> };
};

async function getDoc(): Promise<OpenAPIDoc> {
  const res = await api<OpenAPIDoc>("GET", "/openapi.json");
  expect(res.status).toBe(200);
  return res.body;
}

const PUBLIC_ENDPOINTS = [
  ["post", "/trips"],
  ["post", "/trips/join"],
] as const;

const PROTECTED_ENDPOINTS = [
  ["get", "/trips/{tripId}"],
  ["patch", "/trips/{tripId}"],
  ["post", "/trips/{tripId}/reveal"],
  ["delete", "/trips/{tripId}/members/{memberId}"],
  ["post", "/trips/{tripId}/media"],
  ["post", "/media/{mediaId}/complete"],
  ["get", "/trips/{tripId}/feed"],
  ["get", "/trips/{tripId}/media/{mediaId}/{variant}"],
  ["delete", "/media/{mediaId}"],
] as const;

describe("GET /openapi.json", () => {
  it("publica un documento OpenAPI 3.1 de la API de Rollo", async () => {
    const doc = await getDoc();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Rollo API");
    expect(doc.info.version).toEqual(expect.any(String));
  });

  it("documenta todos los endpoints", async () => {
    const doc = await getDoc();
    for (const [method, path] of [...PUBLIC_ENDPOINTS, ...PROTECTED_ENDPOINTS]) {
      expect(doc.paths[path]?.[method], `${method.toUpperCase()} ${path}`).toBeDefined();
    }
  });

  it("declara auth Bearer y la exige solo donde corresponde", async () => {
    const doc = await getDoc();
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });

    for (const [method, path] of PROTECTED_ENDPOINTS) {
      expect(doc.paths[path]![method]!.security, `${method} ${path}`).toEqual([{ bearerAuth: [] }]);
    }
    for (const [method, path] of PUBLIC_ENDPOINTS) {
      expect(doc.paths[path]![method]!.security, `${method} ${path}`).toBeUndefined();
    }
  });

  it("expone los modelos con nombre para generar el cliente", async () => {
    const doc = await getDoc();
    for (const name of ["Trip", "Member", "TripCreated", "TripDetail", "MediaRegistered", "FeedItem", "Feed", "Error"]) {
      expect(doc.components.schemas[name], name).toBeDefined();
    }
  });

  it("documenta los errores con el formato { error }", async () => {
    const doc = await getDoc();
    expect(doc.paths["/trips/join"]!.post!.responses["404"]).toBeDefined();
    expect(doc.paths["/trips/{tripId}/media"]!.post!.responses["429"]).toBeDefined();
  });
});

describe("openapi.json versionado", () => {
  it("coincide con el contrato que genera el código (si falla: npm run openapi)", async () => {
    const committed = (await import("../openapi.json")).default;
    expect(await getDoc()).toEqual(JSON.parse(JSON.stringify(committed)));
  });
});

describe("GET /docs", () => {
  it("sirve una página de documentación interactiva", async () => {
    const res = await api<string>("GET", "/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.body).toContain("/openapi.json");
  });
});

/**
 * Tests de contrato: las respuestas reales cumplen los esquemas publicados.
 * Si alguien cambia una respuesta sin actualizar el contrato, esto falla.
 */
describe("las respuestas cumplen el contrato", () => {
  it("crear viaje y unirse", async () => {
    const created = await api("POST", "/trips", {
      body: {
        name: "Viaje",
        adminName: "Juani",
        timezone: "America/Argentina/Buenos_Aires",
        startsAt: Date.now(),
        endsAt: Date.now() + 1000,
        revealAt: Date.now() + 2000,
      },
    });
    expect(() => TripCreatedSchema.parse(created.body)).not.toThrow();

    const joined = await api("POST", "/trips/join", { body: { code: created.body.trip.joinCode, name: "Fede" } });
    expect(() => TripCreatedSchema.parse(joined.body)).not.toThrow();
  });

  it("detalle, edición y revelado", async () => {
    const { tripId, adminToken } = await createTrip();
    const detail = await api("GET", `/trips/${tripId}`, { token: adminToken });
    expect(() => TripDetailSchema.parse(detail.body)).not.toThrow();

    const patched = await api("PATCH", `/trips/${tripId}`, { token: adminToken, body: { name: "Otro" } });
    expect(() => TripResponseSchema.parse(patched.body)).not.toThrow();

    const revealed = await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    expect(() => TripResponseSchema.parse(revealed.body)).not.toThrow();
  });

  it("registro, confirmación y feed antes y después del revelado", async () => {
    const { tripId, code, adminToken } = await createTrip();
    const fede = await join(code, "Fede");

    const registered = await api("POST", `/trips/${tripId}/media`, { token: fede.token, body: photoBody() });
    expect(() => MediaRegisteredSchema.parse(registered.body)).not.toThrow();

    const id = await uploadMedia(tripId, fede.token);
    const again = await api("POST", `/media/${id}/complete`, { token: fede.token });
    expect(() => MediaStatusSchema.parse(again.body)).not.toThrow();

    const hidden = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(() => FeedResponseSchema.parse(hidden.body)).not.toThrow();

    await api("POST", `/trips/${tripId}/reveal`, { token: adminToken });
    const shown = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(() => FeedResponseSchema.parse(shown.body)).not.toThrow();
  });

  it("errores", async () => {
    const res = await api("POST", "/trips/join", { body: { code: "ZZZZZZ", name: "Fede" } });
    expect(() => ErrorSchema.parse(res.body)).not.toThrow();
  });
});
