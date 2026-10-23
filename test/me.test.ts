import { describe, expect, it } from "vitest";
import { HOUR, TZ, api, joinAs, newTrip, signUp, uploadMedia } from "./helpers";

describe("GET /me", () => {
  it("returns the profile", async () => {
    const { token, userId, email } = await signUp("fede@rollo.test", "Fede");
    const res = await api("GET", "/me", { token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: userId, email, name: "Fede", username: expect.any(String), avatarUrl: null, bio: null, badge: null, profileVisibility: "friends" });
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

  it("changes the profile visibility", async () => {
    const { token } = await signUp();
    const res = await api("PATCH", "/me", { token, body: { profileVisibility: "public" } });
    expect(res.status).toBe(200);
    expect(res.body.profileVisibility).toBe("public");
    expect((await api("GET", "/me", { token })).body.profileVisibility).toBe("public");
    expect((await api("PATCH", "/me", { token, body: { profileVisibility: "friends" } })).body.profileVisibility).toBe("friends");
  });

  it("keeps the visibility when other fields change", async () => {
    const { token } = await signUp();
    await api("PATCH", "/me", { token, body: { profileVisibility: "public" } });
    expect((await api("PATCH", "/me", { token, body: { name: "Otro" } })).body.profileVisibility).toBe("public");
  });

  it("rejects an unknown profile visibility", async () => {
    const { token } = await signUp();
    for (const profileVisibility of ["everyone", "", null, 1]) {
      expect((await api("PATCH", "/me", { token, body: { profileVisibility } })).status, String(profileVisibility)).toBe(400);
    }
    expect((await api("GET", "/me", { token })).body.profileVisibility).toBe("friends");
  });
});

describe("usernames", () => {
  const INVALID = "El nombre de usuario puede tener letras, números, punto y guion bajo (3 a 30).";
  const TAKEN = "Ese nombre de usuario ya está en uso.";

  it("GET /me has username null until it is set", async () => {
    const { token } = await signUp(undefined, null, null);
    expect((await api("GET", "/me", { token })).body.username).toBeNull();
  });

  it("PATCH /me normalizes and stores the username", async () => {
    const { token } = await signUp(undefined, null, null);
    const res = await api("PATCH", "/me", { token, body: { username: "  @Juani.Fraga " } });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("juani.fraga");
    expect((await api("GET", "/me", { token })).body.username).toBe("juani.fraga");
  });

  it("PATCH /me only changing the username keeps the name", async () => {
    const { token } = await signUp(undefined, "Fede", null);
    const res = await api("PATCH", "/me", { token, body: { username: "fede" } });
    expect(res.body).toMatchObject({ name: "Fede", username: "fede" });
  });

  it("PATCH /me rejects an invalid username with 400", async () => {
    const { token } = await signUp(undefined, "Fede", null);
    for (const username of ["ab", "a..b", "con espacio", ".abc", "x".repeat(31)]) {
      const res = await api("PATCH", "/me", { token, body: { username } });
      expect(res.status, username).toBe(400);
      expect(res.body.error).toBe(INVALID);
    }
  });

  it("PATCH /me returns 409 if someone else has it, case-insensitively", async () => {
    await signUp(undefined, "Ana", "ana.g");
    const { token } = await signUp(undefined, "Otra", null);
    const res = await api("PATCH", "/me", { token, body: { username: "@ANA.G" } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(TAKEN);
  });

  it("PATCH /me setting your own current username is fine", async () => {
    const { token } = await signUp(undefined, "Ana", "ana.mine");
    const res = await api("PATCH", "/me", { token, body: { username: "Ana.Mine" } });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("ana.mine");
  });

  it("GET /usernames/{username} tells if it is available", async () => {
    await signUp(undefined, "Ana", "ana.taken");
    const { token } = await signUp(undefined, "Beto", "beto.mine");
    const free = await api("GET", "/usernames/%40Libre_1", { token });
    expect(free.status).toBe(200);
    expect(free.body).toEqual({ available: true, username: "libre_1" });
    expect((await api("GET", "/usernames/ANA.taken", { token })).body).toEqual({ available: false, username: "ana.taken" });
    expect((await api("GET", "/usernames/beto.mine", { token })).body).toEqual({ available: true, username: "beto.mine" });
  });

  it("GET /usernames/{username} returns 400 for an invalid one and requires a session", async () => {
    const { token } = await signUp();
    const res = await api("GET", "/usernames/a..b", { token });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(INVALID);
    expect((await api("GET", "/usernames/abc")).status).toBe(401);
  });

  it("join and create trip require a username", async () => {
    const admin = await newTrip();
    const user = await signUp(undefined, "Sin usuario", null);
    const join = await api("POST", "/trips/join", { token: user.token, body: { code: admin.code } });
    expect(join.status).toBe(409);
    expect(join.body.error).toBe("Elegí tu nombre de usuario en el perfil");
    const create = await api("POST", "/trips", {
      token: user.token,
      body: { name: "X", timezone: TZ, startsAt: Date.now() + HOUR, endsAt: Date.now() + 2 * HOUR, revealAt: Date.now() + 3 * HOUR },
    });
    expect(create.status).toBe(409);
    await api("PATCH", "/me", { token: user.token, body: { username: "ya.tengo" } });
    expect((await api("POST", "/trips/join", { token: user.token, body: { code: admin.code } })).status).toBe(201);
  });

  it("members, me and feed authors include username", async () => {
    const { tripId, code, adminToken } = await newTrip();
    const friend = await joinAs(code, "Cami");
    await uploadMedia(tripId, friend.token);
    const detail = await api("GET", `/trips/${tripId}`, { token: adminToken });
    const usernames = detail.body.members.map((m: any) => m.username);
    expect(usernames).toHaveLength(2);
    expect(usernames.every((u: unknown) => typeof u === "string")).toBe(true);
    expect(detail.body.me.username).toEqual(expect.any(String));
    const feed = await api("GET", `/trips/${tripId}/feed`, { token: adminToken });
    expect(feed.body.items[0].author.username).toEqual(expect.any(String));
  });
});

describe("profile bio", () => {
  const TOO_LONG = "La descripción puede tener hasta 150 caracteres";
  const TOO_MANY_LINES = "La descripción puede tener hasta 3 renglones";

  it("PATCH /me stores the bio trimmed and GET /me returns it", async () => {
    const { token } = await signUp();
    const res = await api("PATCH", "/me", { token, body: { bio: "  Viajando por el sur  " } });
    expect(res.status).toBe(200);
    expect(res.body.bio).toBe("Viajando por el sur");
    expect((await api("GET", "/me", { token })).body.bio).toBe("Viajando por el sur");
  });

  it("an empty or blank bio clears it", async () => {
    const { token } = await signUp();
    await api("PATCH", "/me", { token, body: { bio: "Algo" } });
    const res = await api("PATCH", "/me", { token, body: { bio: "" } });
    expect(res.status).toBe(200);
    expect(res.body.bio).toBeNull();
    await api("PATCH", "/me", { token, body: { bio: "Algo" } });
    expect((await api("PATCH", "/me", { token, body: { bio: "  \n " } })).body.bio).toBeNull();
    expect((await api("GET", "/me", { token })).body.bio).toBeNull();
  });

  it("accepts 150 characters and rejects 151 with 400", async () => {
    const { token } = await signUp();
    expect((await api("PATCH", "/me", { token, body: { bio: "x".repeat(150) } })).status).toBe(200);
    const res = await api("PATCH", "/me", { token, body: { bio: "x".repeat(151) } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(TOO_LONG);
    // Surrounding spaces do not count.
    expect((await api("PATCH", "/me", { token, body: { bio: `  ${"x".repeat(150)}  ` } })).status).toBe(200);
  });

  it("accepts 3 lines and rejects 4 with 400, counting CRLF as one break", async () => {
    const { token } = await signUp();
    const three = await api("PATCH", "/me", { token, body: { bio: "uno\ndos\r\ntres" } });
    expect(three.status).toBe(200);
    expect(three.body.bio).toBe("uno\ndos\r\ntres");
    for (const bio of ["a\nb\nc\nd", "a\r\nb\r\nc\r\nd", "a\n\n\nb"]) {
      const res = await api("PATCH", "/me", { token, body: { bio } });
      expect(res.status, JSON.stringify(bio)).toBe(400);
      expect(res.body.error).toBe(TOO_MANY_LINES);
    }
    // Trailing breaks are trimmed away before counting.
    expect((await api("PATCH", "/me", { token, body: { bio: "a\nb\nc\n\n" } })).body.bio).toBe("a\nb\nc");
  });

  it("PATCH /me without bio keeps it, and changing the bio keeps name and username", async () => {
    const { token } = await signUp(undefined, "Fede", "fede.bio");
    await api("PATCH", "/me", { token, body: { bio: "Hola" } });
    const res = await api("PATCH", "/me", { token, body: { name: "Federico" } });
    expect(res.body).toMatchObject({ name: "Federico", username: "fede.bio", bio: "Hola" });
    expect((await api("GET", "/me", { token })).body.bio).toBe("Hola");
    const onlyBio = await api("PATCH", "/me", { token, body: { bio: "Chau" } });
    expect(onlyBio.body).toMatchObject({ name: "Federico", username: "fede.bio", bio: "Chau" });
  });
});
