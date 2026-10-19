import { swaggerUI } from "@hono/swagger-ui";
import { HTTPException } from "hono/http-exception";
import { createApp } from "./lib/openapi";
import media from "./routes/media";
import trips from "./routes/trips";

const app = createApp();

app.get("/", (c) => c.json({ ok: true, service: "rollo-api" }));

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description: "Token que devuelven crear o unirse a un viaje",
});

app.route("/trips", trips);
app.route("/", media);

// Contrato: de acá la app mobile genera su cliente tipado.
app.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Rollo API",
    version: "0.2.0",
    description: "Backend de Rollo: viajes, rollos compartidos y revelado al final.",
  },
  servers: [{ url: "https://rollo-api.juanifraga.com" }],
});

app.get("/docs", swaggerUI({ url: "/openapi.json", title: "Rollo API" }));

app.notFound((c) => c.json({ error: "No encontrado" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Error interno" }, 500);
});

export default app;
