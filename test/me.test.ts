import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers";

describe("GET /me", () => {
  it("returns the profile", async () => {
    const { token, userId, email } = await signUp("fede@rollo.test", "Fede");
    const res = await api("GET", "/me", { token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: userId, email, name: "Fede", avatarUrl: null });
  });

  it("name is null until it is set", async () => {
    const { token } = await signUp(undefined, null);
    expect((await api("GET", "/me", { token })).body.name).toBeNull();
  });

  it("requires a session", async () => {
    expect((await api("GET", "/me")).status).toBe(401);
  });
});

describe("PATCH /me", () => {
  it("sets the name, trimmed", async () => {
    const { token, userId } = await signUp(undefined, null);
    const res = await api("PATCH", "/me", { token, body: { name: "  Fede G  " } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: userId, name: "Fede G" });
    expect((await api("GET", "/me", { token })).body.name).toBe("Fede G");
  });

  it("changes an existing name", async () => {
    const { token } = await signUp(undefined, "Fede");
    expect((await api("PATCH", "/me", { token, body: { name: "Federico" } })).body.name).toBe("Federico");
  });

  it("rejects an empty or too long name", async () => {
    const { token } = await signUp();
    for (const name of ["", "   ", "x".repeat(31)]) {
      expect((await api("PATCH", "/me", { token, body: { name } })).status, name).toBe(400);
    }
    expect((await api("PATCH", "/me", { token, body: { name: "x".repeat(30) } })).status).toBe(200);
  });

  it("doesn't need names to be unique", async () => {
    await signUp(undefined, "Fede");
    const { token } = await signUp();
    expect((await api("PATCH", "/me", { token, body: { name: "fede" } })).status).toBe(200);
  });

  it("only changes your own profile", async () => {
    const a = await signUp(undefined, "Ana");
    const b = await signUp(undefined, "Beto");
    await api("PATCH", "/me", { token: a.token, body: { name: "Ana M" } });
    expect((await api("GET", "/me", { token: b.token })).body.name).toBe("Beto");
  });

  it("requires a session", async () => {
    expect((await api("PATCH", "/me", { body: { name: "x" } })).status).toBe(401);
  });
});
