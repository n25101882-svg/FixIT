import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { createApp } from "../dist/app.js";
import { requireLocalTestDatabase } from "../dist/config.js";
import { checkDatabase, createDatabaseClient } from "../dist/database/client.js";
import { createOrderService } from "../dist/orders/service.js";
import { issueToken } from "../dist/auth/token.js";

const database = createDatabaseClient(requireLocalTestDatabase(process.env.TEST_DATABASE_URL));
const options = { database, jwtSecret: randomBytes(48).toString("hex"), tokenTtlSeconds: 900,
  corsOrigins: ["http://127.0.0.1:5173"], rateLimit: { limit: 1000, windowMs: 60000 } };
const app = createApp(() => checkDatabase(database), options);
const commands = createOrderService(database);
const suffix = `@${randomUUID()}.offers-api.fixit.test`;
const city = `Місто ${randomUUID().slice(0, 8)}`;
const input = { title: "Синтетична заявка US-06", description: "Без персональних даних", city, category: "PLUMBING" };
let client, outsider, a, b, otherCity, otherCategory, wildcard;
async function account(name, role = "CLIENT", profile = {}) {
  const password = randomBytes(24).toString("hex");
  const body = { email: name + suffix, name: `Synthetic ${name}`, password, passwordConfirmation: password, role,
    ...(role === "MASTER" ? { city, category: "PLUMBING", profileDescription: "Synthetic profile", serviceTitle: "Synthetic service", serviceDescription: "Synthetic service description", ...profile } : {}) };
  const result = await request(app).post("/api/v1/auth/register").send(body).expect(201);
  const user = result.body.user;
  return { ...user, token: issueToken(user.id, options), profile: await database.masterProfile.findUnique({ where: { userId: user.id } }) };
}
const call = (user, method, path) => request(app)[method](`/api/v1${path}`).set("Authorization", `Bearer ${user.token}`);
const create = async (data = {}) => (await call(client, "post", "/orders").send({ ...input, ...data }).expect(201)).body.order;
const offer = (user, id, body = { message: "  Можу допомогти з цією проблемою  " }) => call(user, "post", `/master/orders/${id}/responses`).send(body);
const responses = (user, id) => call(user, "get", `/orders/${id}/responses`);
const choose = (user, id, responseId) => call(user, "post", `/orders/${id}/select-response`).send({ responseId });
const feed = (user = a) => call(user, "get", "/master/orders/available");
const assigned = (user = a) => call(user, "get", "/master/orders/assigned");
function assertPublic(data) {
  expect(JSON.stringify(data)).not.toMatch(/password|email|userId|isApproved|actorUserId|statusHistory|clientId/i);
}
beforeAll(async () => {
  await database.$connect();
  client = await account("client"); outsider = await account("outsider");
  a = await account("master-a", "MASTER"); b = await account("master-b", "MASTER");
  otherCity = await account("other-city", "MASTER", { city: `Інше ${city}` });
  otherCategory = await account("other-category", "MASTER", { category: "OTHER" });
  wildcard = await account("wildcard", "MASTER", { city: "%" });
});
afterAll(async () => {
  // Committed selection histories and their FK-linked synthetic fixtures remain
  // in the guarded *_test DB. Never disable triggers to remove accepted offers.
  await database.$disconnect();
});
const routes = [
  ["get", "/master/orders/available"], ["get", "/master/orders/assigned"],
  ["post", `/master/orders/${randomUUID()}/responses`],
  ["get", `/orders/${randomUUID()}/responses`], ["post", `/orders/${randomUUID()}/select-response`],
];
describe("offer endpoints trust only verified JWT identity and database roles", () => {
  test.each(routes)("%s %s requires JWT", async (method, path) => {
    await request(app)[method](`/api/v1${path}`).send(method === "post" ? {} : undefined).expect(401);
  });
  test.each(routes.slice(0, 3))("CLIENT cannot access %s %s", async (method, path) => {
    await call(client, method, path).send(method === "post" ? {} : undefined).expect(403);
  });
  test.each(routes.slice(3))("MASTER cannot access %s %s", async (method, path) => {
    await call(a, method, path).send(method === "post" ? {} : undefined).expect(403);
  });
  test("an internal ADMIN has no MASTER or CLIENT offer permissions", async () => {
    const admin = await database.user.create({ data: { email: "admin" + suffix, name: "Internal synthetic", passwordHash: "synthetic-unused-hash", role: "ADMIN" } });
    for (const [method, path] of routes) await call({ token: issueToken(admin.id, options) }, method, path).send(method === "post" ? {} : undefined).expect(403);
  });
  test("MASTER without profile gets a safe 403", async () => {
    const legacy = await database.user.create({ data: { email: "legacy" + suffix, name: "Synthetic legacy", passwordHash: "synthetic-unused-hash", role: "MASTER" } });
    await feed({ token: issueToken(legacy.id, options) }).expect(403);
  });
  test.each(["invalid", "expired"])("rejects %s JWT", async (kind) => {
    await feed({ token: kind === "invalid" ? "invalid.token" : issueToken(a.id, { ...options, tokenTtlSeconds: -10 }) }).expect(401);
  });
});
describe("server-filtered MASTER feed and transactional response eligibility", () => {
  test("feed includes only OPEN CUSTOM in the literal case-insensitive profile city and exact category", async () => {
    const matching = await create(); const uppercase = await create({ city: city.toUpperCase() });
    const wrongCity = await create({ city: "Elsewhere" }); const wrongCategory = await create({ category: "OTHER" });
    const closed = await create(); await call(client, "delete", `/orders/${closed.id}`).expect(200);
    const rows = (await feed().expect(200)).body.orders;
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([matching.id, uppercase.id]));
    for (const id of [wrongCity.id, wrongCategory.id, closed.id]) expect(rows.some((r) => r.id === id)).toBe(false);
    expect(rows.every((r) => r.status === "OPEN" && r.type === "CUSTOM" && r.category === "PLUMBING" && r.city.toLowerCase() === city.toLowerCase())).toBe(true);
    expect(rows.map((r) => r.id)).toEqual([...rows].sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt) || y.id.localeCompare(x.id)).map((r) => r.id));
    assertPublic(rows);
    expect((await offer(a, uppercase.id).expect(201)).body.response.message).toBe("Можу допомогти з цією проблемою");
  });
  test("query parameters cannot override profile city/category/identity", async () => {
    for (const query of [{ city: "Elsewhere" }, { category: "OTHER" }, { masterProfileId: b.profile.id }, { clientId: outsider.id }])
      await feed().query(query).expect(400);
  });
  test.each(["PENDING", "DECLINED"])("STANDARD %s in the same city/category never enters CUSTOM feed or offers", async (status) => {
    const service = await database.service.findFirstOrThrow({ where: { masterProfileId: a.profile.id } });
    const order = await commands.createStandard(client.id, { serviceId: service.id, masterProfileId: a.profile.id, description: "Synthetic standard" });
    if (status === "DECLINED") await commands.transition(a.id, { orderId: order.id, status });
    expect((await feed()).body.orders.some((r) => r.id === order.id)).toBe(false);
    await offer(a, order.id).expect(409); await responses(client, order.id).expect(400);
    expect((await assigned()).body.orders.find((r) => r.id === order.id)).toMatchObject({ type: "STANDARD", status });
    expect((await assigned(b)).body.orders.some((r) => r.id === order.id)).toBe(false);
  });
  test.each(["city", "category"])("direct POST cannot bypass the %s filter and creates nothing", async (field) => {
    const order = await create(); const actor = field === "city" ? otherCity : otherCategory;
    await offer(actor, order.id).expect(403);
    expect(await database.orderResponse.count({ where: { orderId: order.id } })).toBe(0);
    await expect(commands.respond(actor.id, { orderId: order.id, message: "Direct domain bypass attempt" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  test("LIKE wildcard city is literal and cannot widen reads or writes", async () => {
    const other = await create(); const literal = await create({ city: "%" });
    const rows = (await feed(wildcard).expect(200)).body.orders;
    // Earlier runs intentionally retain synthetic histories in this test DB.
    expect(rows.map((r) => r.id)).toContain(literal.id);
    expect(rows.every((r) => r.city === "%")).toBe(true);
    expect(rows.some((r) => r.id === other.id)).toBe(false);
    await offer(wildcard, other.id).expect(403); await offer(wildcard, literal.id).expect(201);
  });
  test.each(["A_B", "A\\B"])("literal city %s also escapes underscore/backslash", async (literalCity) => {
    const master = await account(randomUUID(), "MASTER", { city: literalCity });
    const match = await create({ city: literalCity }); const mismatch = await create({ city: "AXB" });
    const ids = (await feed(master).expect(200)).body.orders.map((r) => r.id);
    expect(ids).toContain(match.id); expect(ids).not.toContain(mismatch.id);
    await offer(master, match.id).expect(201); await offer(master, mismatch.id).expect(403);
  });
  test("201 creates the JWT master's text response and own response marker only", async () => {
    const order = await create(); const result = (await offer(a, order.id).expect(201)).body.response;
    const stored = await database.orderResponse.findUniqueOrThrow({ where: { id: result.id } });
    expect(stored.masterProfileId).toBe(a.profile.id); expect(stored.proposedPrice).toBeNull();
    expect(result.message).toBe("Можу допомогти з цією проблемою"); assertPublic(result);
    const mine = (await feed(a)).body.orders.find((r) => r.id === order.id);
    const theirs = (await feed(b)).body.orders.find((r) => r.id === order.id);
    expect(mine.myResponse.id).toBe(result.id); expect(theirs.myResponse).toBeNull();
  });
  test("repeated response is 409, preserving the first text", async () => {
    const order = await create(); await offer(a, order.id).expect(201);
    await offer(a, order.id, { message: "Replacement forbidden" }).expect(409);
    expect(await database.orderResponse.count({ where: { orderId: order.id } })).toBe(1);
  });
  test("concurrent duplicate responses commit once and return 201/409", async () => {
    const order = await create(); const result = await Promise.all([offer(a, order.id), offer(a, order.id)]);
    expect(result.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await database.orderResponse.count({ where: { orderId: order.id } })).toBe(1);
  });
  test.each([{}, { message: " " }, { message: "x".repeat(2001) }, { message: 123 }, { message: "OK", masterProfileId: "spoof" }, { message: "OK", userId: "spoof" }, { message: "OK", proposedPrice: "10.00" }])("invalid/spoofed response payload %# returns 400", async (body) => {
    const order = await create(); await offer(a, order.id, body).expect(400);
    expect(await database.orderResponse.count({ where: { orderId: order.id } })).toBe(0);
  });
  test.each(["CANCELLED", "ACCEPTED", "IN_PROGRESS", "COMPLETED"])("%s cannot receive another response or appear in feed", async (status) => {
    const order = await create();
    if (status === "CANCELLED") await call(client, "delete", `/orders/${order.id}`).expect(200);
    else {
      const response = (await offer(a, order.id).expect(201)).body.response;
      await choose(client, order.id, response.id).expect(200);
      if (["IN_PROGRESS", "COMPLETED"].includes(status)) await commands.transition(a.id, { orderId: order.id, status: "IN_PROGRESS" });
      if (status === "COMPLETED") await commands.transition(a.id, { orderId: order.id, status: "COMPLETED" });
    }
    await offer(b, order.id).expect(409);
    expect((await feed()).body.orders.some((r) => r.id === order.id)).toBe(false);
  });
});
describe("owner-only offers and atomic single-executor selection", () => {
  test("only the CLIENT owner reads offers, with explicitly public master fields", async () => {
    const order = await create(); const response = (await offer(a, order.id).expect(201)).body.response;
    await responses(outsider, order.id).expect(403);
    const body = (await responses(client, order.id).expect(200)).body;
    expect(body.responses).toHaveLength(1);
    expect(body.responses[0]).toMatchObject({ id: response.id, message: response.message, master: { id: a.profile.id, name: a.name, city, category: "PLUMBING" } });
    assertPublic(body.responses);
  });
  test("empty offers list is a real 200 with current OPEN order", async () => {
    const order = await create(); const body = (await responses(client, order.id).expect(200)).body;
    expect(body.responses).toEqual([]); expect(body.order.status).toBe("OPEN");
  });
  test("another CLIENT cannot select a response", async () => {
    const order = await create(); const response = (await offer(a, order.id).expect(201)).body.response;
    await choose(outsider, order.id, response.id).expect(403);
    expect((await database.order.findUniqueOrThrow({ where: { id: order.id } })).masterProfileId).toBeNull();
  });
  test("a nonexistent response or response from another order is 404 and cannot assign an arbitrary master", async () => {
    const order = await create(); const other = await create(); const response = (await offer(a, other.id).expect(201)).body.response;
    await choose(client, order.id, randomUUID()).expect(404); await choose(client, order.id, response.id).expect(404);
    await call(client, "post", `/orders/${order.id}/select-response`).send({ masterProfileId: b.profile.id }).expect(400);
    await call(client, "post", `/orders/${order.id}/select-response`).send({ responseId: response.id, clientId: outsider.id }).expect(400);
    expect((await responses(client, order.id)).body.order.status).toBe("OPEN");
  });
  test("concurrent choices yield 200/409, persist ACCEPTED once, expose only winner in assigned cabinet", async () => {
    const order = await create(); const ra = (await offer(a, order.id).expect(201)).body.response;
    const rb = (await offer(b, order.id).expect(201)).body.response;
    const results = await Promise.all([choose(client, order.id, ra.id), choose(client, order.id, rb.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const chosen = results.find((r) => r.status === 200).body.order;
    const winner = chosen.masterProfileId === a.profile.id ? a : b; const loser = winner === a ? b : a;
    expect(chosen).toMatchObject({ status: "ACCEPTED", assignedMaster: { id: winner.profile.id, name: winner.name } });
    const stored = await database.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.status).toBe("ACCEPTED"); expect(stored.statusHistory.map((e) => e.status)).toEqual(["OPEN", "ACCEPTED"]);
    await choose(client, order.id, ra.id).expect(409);
    expect((await database.order.findUniqueOrThrow({ where: { id: order.id } })).statusHistory).toEqual(stored.statusHistory);
    expect((await responses(client, order.id)).body.order).toMatchObject(chosen);
    const ownList = (await call(client, "get", "/orders")).body.orders;
    expect(ownList.find((r) => r.id === order.id).assignedMaster.name).toBe(winner.name);
    const assignedRows = (await assigned(winner).expect(200)).body.orders;
    expect(assignedRows.some((r) => r.id === order.id && r.status === "ACCEPTED")).toBe(true); assertPublic(assignedRows);
    expect((await assigned(loser)).body.orders.some((r) => r.id === order.id)).toBe(false);
    await call(client, "delete", `/orders/${order.id}`).expect(200).expect((res) => {
      expect(res.body.order).toMatchObject({ status: "CANCELLED", assignedMaster: { name: winner.name } });
    });
    expect((await assigned(winner)).body.orders.find((r) => r.id === order.id).status).toBe("CANCELLED");
    expect(await database.orderResponse.count({ where: { orderId: order.id } })).toBe(2);
  });
  test("closed order cannot select even an existing response", async () => {
    const order = await create(); const response = (await offer(a, order.id).expect(201)).body.response;
    await call(client, "delete", `/orders/${order.id}`).expect(200);
    await choose(client, order.id, response.id).expect(409);
  });
  test.each(["not-a-uuid", randomUUID()])("safe validation/not-found for order %s", async (id) => {
    const status = id === "not-a-uuid" ? 400 : 404;
    await responses(client, id).expect(status); await offer(a, id).expect(status);
    await choose(client, id, randomUUID()).expect(status);
  });
  test("UUID validation rejects malformed response and list query overrides", async () => {
    const order = await create(); await choose(client, order.id, "not-a-uuid").expect(400);
    await responses(client, order.id).query({ clientId: outsider.id }).expect(400);
    await assigned().query({ masterProfileId: b.profile.id }).expect(400);
  });
});
