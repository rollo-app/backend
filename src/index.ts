import { swaggerUI } from "@hono/swagger-ui";
import { HTTPException } from "hono/http-exception";
import { createApp } from "./lib/openapi";
import { DEV_UPLOAD_PREFIX, devUploadsEnabled, verifyDevUpload } from "./lib/r2";
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

// Solo en desarrollo (DEV_LOCAL_UPLOADS=1): recibe los PUT que en producción van directo a R2.
// No es parte del contrato; apagado, la ruta no existe.
app.put(`${DEV_UPLOAD_PREFIX}*`, async (c, next) => {
  if (!devUploadsEnabled(c.env)) return next();
  const key = decodeURIComponent(new URL(c.req.url).pathname.slice(DEV_UPLOAD_PREFIX.length));
  if (!(await verifyDevUpload(c.env, key, c.req.query("exp"), c.req.query("sig")))) {
    return c.json({ error: "Firma inválida o vencida" }, 403);
  }
  const contentType = c.req.header("content-type");
  await c.env.MEDIA.put(key, await c.req.arrayBuffer(), contentType ? { httpMetadata: { contentType } } : undefined);
  return c.body(null, 200);
});

app.notFound((c) => c.json({ error: "No encontrado" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Error interno" }, 500);
});

export default app;
