import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../dist/app.js";
import { requireLocalTestDatabase, loadAuthConfig } from "../dist/config.js";
import {
  createDatabaseClient,
  checkDatabase,
} from "../dist/database/client.js";
import { verifyPassword } from "../dist/auth/password.js";
import { tokenIssuer, tokenAudience } from "../dist/auth/token.js";

const database = createDatabaseClient(
  requireLocalTestDatabase(process.env.TEST_DATABASE_URL),
);
const secret = randomBytes(48).toString("hex");
const suffix = `@${randomUUID()}.auth-tests.fixit.test`;
const password = "Synthetic test passphrase 2026!";
const options = {
  database,
  jwtSecret: secret,
  tokenTtlSeconds: 900,
  corsOrigins: ["http://127.0.0.1:5173"],
  rateLimit: { limit: 1000, windowMs: 60000 },
};
const app = createApp(() => checkDatabase(database), options);
const email = (name) => name + suffix;
const register = (name, extra = {}) =>
  request(app)
    .post("/api/v1/auth/register")
    .send({
      email: email(name),
      password,
      passwordConfirmation: password,
      name: "Синтетичний користувач",
      ...extra,
    });
let client;
let token;

beforeAll(async () => {
  await database.$connect();
  client = (await register("client").expect(201)).body.user;
  token = (
    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: client.email, password })
      .expect(200)
  ).body.accessToken;
});
afterAll(async () => {
  const owner = { email: { endsWith: suffix } };
  await database.$transaction(async (tx) => {
    await tx.service.deleteMany({ where: { masterProfile: { user: owner } } });
    await tx.masterProfile.deleteMany({ where: { user: owner } });
    await tx.user.deleteMany({ where: owner });
  });
  await database.$disconnect();
});

describe("registration and credentials", () => {
  test("registers a CLIENT with normalized email and a salted scrypt hash", async () => {
    const response = await register("normalized", {
      email: `  NORMALIZED${suffix.toUpperCase()}  `,
    }).expect(201);
    expect(Object.keys(response.body.user).sort()).toEqual([
      "email",
      "id",
      "name",
      "role",
    ]);
    expect(response.body.user.role).toBe("CLIENT");
    expect(response.body.user.email).toBe(email("normalized"));
    const stored = await database.user.findUniqueOrThrow({
      where: { id: response.body.user.id },
    });
    expect(stored.passwordHash).not.toBe(password);
    expect(stored.passwordHash).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(await verifyPassword(password, stored.passwordHash)).toBe(true);
    const other = await database.user.findUniqueOrThrow({
      where: { id: client.id },
    });
    expect(stored.passwordHash).not.toBe(other.passwordHash);
  });
  test("registers MASTER with the supplied profile and first service", async () => {
    const { body } = await register("master", {
      role: "MASTER", city: "Синтетичне місто", category: "OTHER",
      profileDescription: "Синтетичний профіль", serviceTitle: "Синтетична послуга",
      serviceDescription: "Опис синтетичної послуги",
    }).expect(201);
    expect(body.user.role).toBe("MASTER");
    expect(
      await database.masterProfile.count({ where: { userId: body.user.id } }),
    ).toBe(1);
  });
  test("logs in and returns a signed expiring JWT and a safe user DTO", async () => {
    const { body } = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: `  ${client.email.toUpperCase()} `, password })
      .expect(200);
    const payload = jwt.verify(body.accessToken, secret, {
      algorithms: ["HS256"],
      issuer: tokenIssuer,
      audience: tokenAudience,
    });
    expect(payload.sub).toBe(client.id);
    expect(payload.exp - payload.iat).toBe(900);
    expect(body.tokenType).toBe("Bearer");
    expect(Object.keys(body.user).sort()).toEqual([
      "email",
      "id",
      "name",
      "role",
    ]);
  });
  test("rejects duplicate email irrespective of case", async () => {
    const response = await register("duplicate", {
      email: client.email.toUpperCase(),
    }).expect(409);
    expect(response.body.error.code).toBe("EMAIL_TAKEN");
    expect(await database.user.count({ where: { email: client.email } })).toBe(
      1,
    );
  });
  test("wrong passwords and unknown accounts return the same 401", async () => {
    const wrong = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: client.email, password: "Wrong synthetic password" })
      .expect(401);
    const unknown = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: email("unknown"), password })
      .expect(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe("INVALID_CREDENTIALS");
  });
  test.each([
    { email: "invalid" },
    { password: "short" },
    { password: "x".repeat(129) },
    { name: " " },
  ])("validates registration fields (%#)", async (extra) => {
    expect((await register("invalid", extra).expect(400)).body.error.code).toBe(
      "VALIDATION_ERROR",
    );
  });
  test("rejects self-assigned ADMIN and mass-assigned protected fields", async () => {
    await register("admin", { role: "ADMIN" }).expect(400);
    await register("injected", {
      passwordHash: "injected",
      isApproved: true,
    }).expect(400);
    expect(
      await database.user.count({
        where: { email: { in: [email("admin"), email("injected")] } },
      }),
    ).toBe(0);
  });
});

describe("JWT middleware and users/me", () => {
  test("missing bearer token returns 401", async () => {
    await request(app).get("/api/v1/users/me").expect(401);
  });
  test("invalid bearer token returns 401", async () => {
    await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", "Bearer invalid.token.value")
      .expect(401);
  });
  test("expired token returns 401", async () => {
    const expired = jwt.sign({}, secret, {
      subject: client.id,
      expiresIn: -60,
      issuer: tokenIssuer,
      audience: tokenAudience,
    });
    await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${expired}`)
      .expect(401);
  });
  test.each([
    "wrong-key",
    "wrong-algorithm",
    "wrong-audience",
    "missing-expiration",
  ])("rejects %s", async (kind) => {
    const settings = {
      subject: client.id,
      expiresIn: 900,
      issuer: tokenIssuer,
      audience: tokenAudience,
      algorithm: "HS256",
    };
    if (kind === "wrong-algorithm") settings.algorithm = "HS384";
    if (kind === "wrong-audience") settings.audience = "another-app";
    if (kind === "missing-expiration") delete settings.expiresIn;
    const value = jwt.sign(
      {},
      kind === "wrong-key" ? randomBytes(48).toString("hex") : secret,
      settings,
    );
    await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${value}`)
      .expect(401);
  });
  test("returns only id/email/name/role and reads the current database role", async () => {
    const response = await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(response.body).toEqual({ user: client });
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    await database.user.update({
      where: { id: client.id },
      data: { role: "MASTER" },
    });
    try {
      const current = await request(app)
        .get("/api/v1/users/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(current.body.user.role).toBe("MASTER");
    } finally {
      await database.user.update({
        where: { id: client.id },
        data: { role: "CLIENT" },
      });
    }
  });
  test("rejects a token whose account was deleted", async () => {
    const user = (await register("deleted").expect(201)).body.user;
    const accessToken = jwt.sign({}, secret, {
      subject: user.id,
      expiresIn: 900,
      issuer: tokenIssuer,
      audience: tokenAudience,
    });
    await database.user.delete({ where: { id: user.id } });
    await request(app)
      .get("/api/v1/users/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(401);
  });
});

describe("HTTP and environment boundaries", () => {
  test("CORS permits only the configured frontend and rejects other origins", async () => {
    const preflight = await request(app)
      .options("/api/v1/users/me")
      .set("Origin", options.corsOrigins[0])
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "authorization")
      .expect(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(
      options.corsOrigins[0],
    );
    expect(
      preflight.headers["access-control-allow-credentials"],
    ).toBeUndefined();
    await request(app)
      .post("/api/v1/auth/register")
      .set("Origin", "https://untrusted.example")
      .send({ email: email("evil"), password, name: "Synthetic" })
      .expect(403);
    expect(await database.user.count({ where: { email: email("evil") } })).toBe(
      0,
    );
  });
  test("limits authentication attempts", async () => {
    const limited = createApp(() => checkDatabase(database), {
      ...options,
      rateLimit: { limit: 1, windowMs: 60000 },
    });
    await request(limited).post("/api/v1/auth/login").send({}).expect(400);
    expect(
      (await request(limited).post("/api/v1/auth/login").send({}).expect(429))
        .body.error.code,
    ).toBe("RATE_LIMITED");
  });
  test("malformed/oversized JSON does not expose request data or stack traces", async () => {
    const bad = await request(app)
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send('{"password":"sensitive-test-input",')
      .expect(400);
    expect(bad.body.error.code).toBe("INVALID_JSON");
    expect(JSON.stringify(bad.body)).not.toContain("sensitive-test-input");
    await request(app)
      .post("/api/v1/auth/login")
      .send({ password: "x".repeat(20000) })
      .expect(413);
  });
  test("requires a strong environment secret and exact CORS origins", () => {
    const previous = {
      JWT_SECRET: process.env.JWT_SECRET,
      CORS_ORIGINS: process.env.CORS_ORIGINS,
    };
    try {
      delete process.env.JWT_SECRET;
      expect(() => loadAuthConfig()).toThrow("JWT_SECRET");
      process.env.JWT_SECRET = "short";
      expect(() => loadAuthConfig()).toThrow("JWT_SECRET");
      process.env.JWT_SECRET = secret;
      process.env.CORS_ORIGINS = "*";
      expect(() => loadAuthConfig()).toThrow("CORS_ORIGINS");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
