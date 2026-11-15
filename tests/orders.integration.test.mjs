import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { createApp } from "../dist/app.js";
import { requireLocalTestDatabase } from "../dist/config.js";
import { checkDatabase, createDatabaseClient } from "../dist/database/client.js";
import { seedDatabase, seedIds } from "../dist/database/seed.js";
import { createOrderService } from "../dist/orders/service.js";
import { issueToken } from "../dist/auth/token.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
const options = { database, jwtSecret: randomBytes(48).toString("hex"), tokenTtlSeconds: 900,
  corsOrigins: ["http://127.0.0.1:5173"], rateLimit: { limit: 1000, windowMs: 60000 } };
const app = createApp(() => checkDatabase(database), options);
const commands = createOrderService(database);
const suffix = `@${randomUUID()}.orders-api.fixit.test`;
const password = "Synthetic orders test passphrase!";
const input = { title: "Синтетична проблема", description: "Синтетичний опис проблеми", city: "Тестоград", category: "PLUMBING" };
let a, b, master;
async function register(name, role = "CLIENT") {
  const body = { email: name + suffix, name: "Синтетичний користувач", password, passwordConfirmation: password, role,
    ...(role === "MASTER" ? { city: "Тестоград", category: "PLUMBING", profileDescription: "Синтетичний профіль", serviceTitle: "Синтетична послуга", serviceDescription: "Опис синтетичної послуги" } : {}) };
  const created = await request(app).post("/api/v1/auth/register").send(body).expect(201);
  const login = await request(app).post("/api/v1/auth/login").send({ email: body.email, password }).expect(200);
  return { ...created.body.user, token: login.body.accessToken };
}
const get = (actor) => request(app).get("/api/v1/orders").set("Authorization", `Bearer ${actor.token}`);
const post = (actor, body = input) => request(app).post("/api/v1/orders").set("Authorization", `Bearer ${actor.token}`).send(body);
const cancel = (actor, id) => request(app).delete(`/api/v1/orders/${id}`).set("Authorization", `Bearer ${actor.token}`);
const stored = (id) => database.order.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  await database.$connect();
  await seedDatabase(database);
  a = await register("client-a"); b = await register("client-b"); master = await register("master", "MASTER");
});
afterAll(async () => {
  // Fixture cleanup only, never the DELETE endpoint: remove only this suite's
  // synthetic rows, without touching seed/concurrency histories or disabling FK.
  const owner = { email: { endsWith: suffix } };
  await database.$transaction(async (tx) => {
    await tx.order.deleteMany({ where: { client: owner } });
    await tx.service.deleteMany({ where: { masterProfile: { user: owner } } });
    await tx.masterProfile.deleteMany({ where: { user: owner } });
    await tx.user.deleteMany({ where: owner });
  });
  await database.$disconnect();
});

describe("JWT and CLIENT access boundary", () => {
  test.each(["get", "post", "delete"])("%s requires a JWT", async (method) => {
    const path = method === "delete" ? `/api/v1/orders/${randomUUID()}` : "/api/v1/orders";
    await request(app)[method](path).send(method === "post" ? input : undefined).expect(401);
  });
  test.each(["invalid", "expired", "wrong-key"])("rejects %s JWT without creating records", async (kind) => {
    const token = kind === "invalid" ? "invalid.token.value" : issueToken(a.id, {
      ...options, ...(kind === "expired" ? { tokenTtlSeconds: -10 } : { jwtSecret: randomBytes(48).toString("hex") }),
    });
    const before = await database.order.count();
    await post({ token }).expect(401);
    expect(await database.order.count()).toBe(before);
  });
  test.each(["get", "post", "delete"])("MASTER cannot %s CLIENT orders", async (method) => {
    const created = (await post(a).expect(201)).body.order;
    if (method === "get") await get(master).expect(403);
    if (method === "post") await post(master).expect(403);
    if (method === "delete") await cancel(master, created.id).expect(403);
    expect((await stored(created.id)).status).toBe("OPEN");
  });
  test("internal ADMIN gets no order permission", async () => {
    const admin = { token: issueToken(seedIds.admin, options) };
    await get(admin).expect(403);
    await post(admin).expect(403);
    await cancel(admin, randomUUID()).expect(403);
  });
  test("a token for a deleted account returns 401", async () => {
    const removed = await register("removed");
    await database.user.delete({ where: { id: removed.id } });
    await get(removed).expect(401);
  });
});

describe("CUSTOM creation and isolated reads", () => {
  test("empty client list is 200 with an empty array", async () => {
    const empty = await register("empty");
    expect((await get(empty).expect(200)).body).toEqual({ orders: [] });
  });
  test("201 copies the verified JWT client, creates OPEN CUSTOM and database history", async () => {
    const { body } = await post(a, { ...input, title: "  Реальна синтетична заявка  ", budget: "250.50" }).expect(201);
    expect(body.order).toMatchObject({ clientId: a.id, title: "Реальна синтетична заявка", type: "CUSTOM", status: "OPEN", serviceId: null, masterProfileId: null, priceAtOrder: null, budget: "250.50" });
    const row = await stored(body.order.id);
    expect(row.budget.toFixed(2)).toBe("250.50");
    expect(row.statusHistory).toHaveLength(1);
    expect(row.statusHistory[0]).toMatchObject({ status: "OPEN", source: "database", actorUserId: a.id });
    expect(JSON.stringify(body)).not.toContain("passwordHash");
    for (const field of ["userId", "address"]) expect(body.order).not.toHaveProperty(field);
  });
  test.each([[undefined, null], ["0", "0.00"], ["99999999.99", "99999999.99"]])("optional budget %s is preserved exactly", async (budget, expected) => {
    expect((await post(a, { ...input, budget }).expect(201)).body.order.budget).toBe(expected);
  });
  test("lists only the current client's records, newest first with stable UUID ties", async () => {
    await post(b, { ...input, title: "Private B" }).expect(201);
    await post(a, { ...input, title: "Newest A" }).expect(201);
    const rows = (await get(a).expect(200)).body.orders;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((order) => order.clientId === a.id)).toBe(true);
    expect(rows.some((order) => order.title === "Private B")).toBe(false);
    const expected = [...rows].sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt) || y.id.localeCompare(x.id));
    expect(rows.map((r) => r.id)).toEqual(expected.map((r) => r.id));
    expect((await get(b).expect(200)).body.orders.every((order) => order.clientId === b.id)).toBe(true);
  });
  test("query parameters cannot select a different client's orders", async () => {
    await get(a).query({ clientId: b.id }).expect(400);
    await get(a).query({ userId: b.id }).expect(400);
  });
});

const invalid = [
  { title: " " }, { title: "x".repeat(161) }, { description: " " }, { description: "x".repeat(4001) },
  { city: " " }, { city: "x".repeat(101) }, { category: "UNKNOWN" }, { category: undefined },
  ...[null, 1.25, "", "-0.01", "1.001", "1e2", "NaN", "100000000.00", "1,25"].map((budget) => ({ budget })),
  { clientId: randomUUID() }, { userId: randomUUID() }, { address: "Not a supported field" },
  { status: "NEW" }, { type: "STANDARD" }, { masterProfileId: randomUUID() }, { serviceId: randomUUID() }, { statusHistory: [] },
];
test.each(invalid)("Zod rejects invalid/mass-assigned input (%#) with no write", async (extra) => {
  const before = await database.order.count();
  const response = await post(a, { ...input, ...extra }).expect(400);
  expect(response.body.error.code).toBe("VALIDATION_ERROR");
  expect(await database.order.count()).toBe(before);
});

describe("logical cancellation delegates to transactional service", () => {
  test("owner cancels OPEN with 200, persists the row and appends exactly one history event", async () => {
    const created = (await post(a).expect(201)).body.order;
    const before = await stored(created.id);
    const count = await database.order.count();
    const result = (await cancel(a, created.id).expect(200)).body.order;
    expect(result.id).toBe(created.id);
    expect(result.status).toBe("CANCELLED");
    expect(await database.order.count()).toBe(count);
    const after = await stored(created.id);
    for (const field of ["title", "description", "city", "category", "clientId", "createdAt"]) expect(after[field]).toEqual(before[field]);
    expect(after.statusHistory[0]).toEqual(before.statusHistory[0]);
    expect(after.statusHistory).toHaveLength(2);
    expect(after.statusHistory.at(-1)).toMatchObject({ status: "CANCELLED", actorUserId: a.id, source: "database" });
    expect((await get(a).expect(200)).body.orders.find((row) => row.id === created.id).status).toBe("CANCELLED");
    await cancel(a, created.id).expect(409);
    expect(await stored(created.id)).toEqual(after);
  });
  test("another client receives 403 without changing the order", async () => {
    const created = (await post(a).expect(201)).body.order;
    const before = await stored(created.id);
    await cancel(b, created.id).expect(403);
    expect(await stored(created.id)).toEqual(before);
  });
  test("missing UUID is 404; malformed UUID and injected body are 400", async () => {
    await cancel(a, randomUUID()).expect(404);
    await cancel(a, "not-a-uuid").expect(400);
    const created = (await post(a).expect(201)).body.order;
    await cancel(a, created.id).send({ status: "COMPLETED" }).expect(400);
    expect((await stored(created.id)).status).toBe("OPEN");
  });
  test.each(["PENDING", "ACCEPTED", "IN_PROGRESS", "COMPLETED", "DECLINED"])("cancellation from %s obeys the existing service rules", async (status) => {
    const standard = await commands.createStandard(a.id, { serviceId: seedIds.serviceA, masterProfileId: seedIds.profileA, description: "Synthetic status fixture" });
    const path = { PENDING: [], ACCEPTED: ["ACCEPTED"], IN_PROGRESS: ["ACCEPTED", "IN_PROGRESS"], COMPLETED: ["ACCEPTED", "IN_PROGRESS", "COMPLETED"], DECLINED: ["DECLINED"] }[status];
    for (const next of path) await commands.transition(seedIds.masterA, { orderId: standard.id, status: next });
    const before = await stored(standard.id);
    const allowed = ["PENDING", "ACCEPTED"].includes(status);
    await cancel(a, standard.id).expect(allowed ? 200 : 409);
    if (!allowed) expect(await stored(standard.id)).toEqual(before);
  });
  test("concurrent cancellations commit only one event (one 200, one 409)", async () => {
    const created = (await post(a).expect(201)).body.order;
    const results = await Promise.all([cancel(a, created.id), cancel(a, created.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await stored(created.id)).statusHistory).toHaveLength(2);
  });
  test("browser DELETE preflight is allowed only for the configured origin", async () => {
    const response = await request(app).options(`/api/v1/orders/${randomUUID()}`).set("Origin", options.corsOrigins[0]).set("Access-Control-Request-Method", "DELETE").set("Access-Control-Request-Headers", "authorization").expect(204);
    expect(response.headers["access-control-allow-methods"]).toContain("DELETE");
    await request(app).options("/api/v1/orders").set("Origin", "https://untrusted.example").set("Access-Control-Request-Method", "DELETE").expect(403);
  });
});
