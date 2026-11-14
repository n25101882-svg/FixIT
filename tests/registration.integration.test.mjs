import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, jest, test } from "@jest/globals";
import request from "supertest";
import { createApp } from "../dist/app.js";
import { requireLocalTestDatabase } from "../dist/config.js";
import { checkDatabase, createDatabaseClient } from "../dist/database/client.js";
import { verifyPassword } from "../dist/auth/password.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
const suffix = `@${randomUUID()}.registration-tests.fixit.test`;
const password = "Synthetic registration passphrase 2026!";
const app = createApp(() => checkDatabase(database), {
  database, jwtSecret: randomBytes(48).toString("hex"), tokenTtlSeconds: 900,
  corsOrigins: ["http://127.0.0.1:5173"], rateLimit: { limit: 1000, windowMs: 60000 },
});
const client = (name) => ({ email: name + suffix, name: "Synthetic client", password, passwordConfirmation: password, role: "CLIENT" });
const master = (name) => ({
  ...client(name), role: "MASTER", city: "  Синтетичне місто  ", category: "PLUMBING",
  profileDescription: "  Синтетичний опис майстра  ", serviceTitle: "  Перша синтетична послуга  ",
  serviceDescription: "  Синтетичний опис першої послуги  ",
});
const register = (body) => request(app).post("/api/v1/auth/register").send(body);
const counts = () => Promise.all([database.user.count(), database.masterProfile.count(), database.service.count()]);
const account = (email) => database.user.findUniqueOrThrow({
  where: { email: email.trim().toLowerCase() }, include: { masterProfile: { include: { services: true } } },
});
beforeAll(() => database.$connect());
afterAll(async () => {
  const owner = { email: { endsWith: suffix } };
  await database.$transaction(async (tx) => {
    await tx.service.deleteMany({ where: { masterProfile: { user: owner } } });
    await tx.masterProfile.deleteMany({ where: { user: owner } });
    await tx.user.deleteMany({ where: owner });
  });
  await database.$disconnect();
});

describe("FIX-1 endpoint with real Hybrid persistence", () => {
  test.each(["TECH_REPAIR", "PLUMBING", "ELECTRICAL", "OTHER"])("MASTER %s creates exactly one User/Profile/Service without requiring a price", async (category) => {
    const input = { ...master(category), category };
    const before = await counts();
    const response = await register(input).expect(201);
    expect(Object.keys(response.body)).toEqual(["user"]);
    expect(Object.keys(response.body.user).sort()).toEqual(["email", "id", "name", "role"]);
    const stored = await account(input.email);
    expect(await counts()).toEqual(before.map((n) => n + 1));
    expect(await verifyPassword(password, stored.passwordHash)).toBe(true);
    expect(stored.masterProfile).toMatchObject({ userId: stored.id, city: input.city.trim(), category, description: input.profileDescription.trim(), isApproved: false });
    expect(stored.masterProfile.services).toHaveLength(1);
    expect(stored.masterProfile.services[0]).toMatchObject({
      masterProfileId: stored.masterProfile.id, category, title: input.serviceTitle.trim(),
      description: input.serviceDescription.trim(), priceEstimate: null, isActive: true,
    });
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    const login = await request(app).post("/api/v1/auth/login").send({ email: input.email, password }).expect(200);
    expect(login.body.accessToken).toEqual(expect.any(String));
    const me = await request(app).get("/api/v1/users/me").set("Authorization", `Bearer ${login.body.accessToken}`).expect(200);
    expect(me.body).toEqual({ user: response.body.user });
    await request(app).get("/api/v1/users/me").expect(401);
  });

  test.each([["0", "0.00"], ["12.34", "12.34"], ["99999999.99", "99999999.99"]])("persists optional exact decimal %s", async (priceEstimate, expected) => {
    const input = { ...master(`price-${priceEstimate}`), priceEstimate };
    await register(input).expect(201);
    expect((await account(input.email)).masterProfile.services[0].priceEstimate.toFixed(2)).toBe(expected);
  });

  test("CLIENT creates only a User", async () => {
    const before = await counts();
    const input = client("only-client");
    const response = await register(input).expect(201);
    expect(response.body.user.role).toBe("CLIENT");
    expect((await account(input.email)).masterProfile).toBeNull();
    expect(await counts()).toEqual([before[0] + 1, before[1], before[2]]);
  });

  test("first Service database failure rolls back User and Profile and returns no success/token", async () => {
    // Add a test-only rejection to this explicitly isolated *_test DB. The
    // payload remains valid, so the failure really occurs on the third INSERT.
    const constraint = `test_registration_${randomUUID().replaceAll("-", "")}`;
    const input = { ...master("rollback"), serviceTitle: `Synthetic failure ${randomUUID()}` };
    const before = await counts();
    await database.$executeRawUnsafe(`ALTER TABLE services ADD CONSTRAINT "${constraint}" CHECK (title <> '${input.serviceTitle}') NOT VALID`);
    try {
      const response = await register(input).expect(500);
      expect(response.body).toEqual({ error: { code: "INTERNAL_ERROR", message: expect.any(String) } });
      expect(JSON.stringify(response.body)).not.toMatch(/accessToken|password|INSERT|constraint|stack/i);
      expect(await counts()).toEqual(before);
      expect(await database.user.findUnique({ where: { email: input.email } })).toBeNull();
      await request(app).post("/api/v1/auth/login").send({ email: input.email, password }).expect(401);
    } finally {
      await database.$executeRawUnsafe(`ALTER TABLE services DROP CONSTRAINT "${constraint}"`);
    }
    await register(input).expect(201);
    expect(await counts()).toEqual(before.map((n) => n + 1));
  });

  test("duplicate canonical MASTER email returns 409 without extra Profile/Service", async () => {
    const input = master("duplicate");
    await register(input).expect(201);
    const before = await counts();
    const response = await register({ ...input, email: ` ${input.email.toUpperCase()} ` }).expect(409);
    expect(response.body.error.code).toBe("EMAIL_TAKEN");
    expect(await counts()).toEqual(before);
    expect((await account(input.email)).masterProfile.services).toHaveLength(1);
  });

  test.each([["MASTER", "MASTER"], ["CLIENT", "MASTER"]])("concurrent %s/%s email registration has one 201, one 409 and no orphan", async (a, b) => {
    const input = master(`race-${a}-${b}`);
    const before = await counts();
    const payload = (role) => role === "MASTER" ? input : client(`race-${a}-${b}`);
    const results = await Promise.all([register(payload(a)), register(payload(b))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = results.find((r) => r.status === 201).body.user;
    const extra = winner.role === "MASTER" ? 1 : 0;
    expect(await counts()).toEqual([before[0] + 1, before[1] + extra, before[2] + extra]);
    const stored = await account(input.email);
    expect(stored.id).toBe(winner.id);
    if (extra) expect(stored.masterProfile.services).toHaveLength(1);
    else expect(stored.masterProfile).toBeNull();
    expect(results.find((r) => r.status === 409).body.error.code).toBe("EMAIL_TAKEN");
  });
});

const invalid = [
  ...["city", "category", "profileDescription", "serviceTitle", "serviceDescription"].map((field) => [`missing ${field}`, { [field]: undefined }]),
  ["blank city", { city: "  " }], ["long city", { city: "x".repeat(101) }],
  ["invalid category", { category: "UNKNOWN" }],
  ["blank profile", { profileDescription: " " }], ["long profile", { profileDescription: "x".repeat(2001) }],
  ["blank title", { serviceTitle: " " }], ["long title", { serviceTitle: "x".repeat(161) }],
  ["blank service description", { serviceDescription: " " }], ["long service description", { serviceDescription: "x".repeat(2001) }],
  ...[1.25, "", "-0.01", "1.001", "1e2", "NaN", "100000000.00", "1,25"].map((priceEstimate) => [`invalid price ${priceEstimate}`, { priceEstimate }]),
  ["missing password confirmation", { passwordConfirmation: undefined }],
  ["different password confirmation", { passwordConfirmation: "Different synthetic password" }],
  ["ADMIN", { role: "ADMIN" }],
  ["injected approval", { isApproved: true }],
  ["injected ownership", { masterProfile: { userId: randomUUID() } }],
];
test.each(invalid)("rejects %s before any write, without partial records", async (_label, extra) => {
  const before = await counts();
  const transaction = jest.spyOn(database, "$transaction");
  try {
    const response = await register({ ...master("invalid"), ...extra }).expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.accessToken).toBeUndefined();
    expect(transaction).not.toHaveBeenCalled();
    expect(await counts()).toEqual(before);
  } finally {
    transaction.mockRestore();
  }
});

test("CLIENT rejects MASTER fields rather than mass-assigning a profile", async () => {
  const before = await counts();
  await register({ ...master("client-injected"), role: "CLIENT" }).expect(400);
  expect(await counts()).toEqual(before);
});
