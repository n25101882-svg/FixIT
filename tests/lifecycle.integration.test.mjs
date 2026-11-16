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
const suffix = `@${randomUUID()}.lifecycle-api.fixit.test`;
const city = `Lifecycle ${randomUUID().slice(0, 8)}`;
let client, otherClient, master, otherMaster;
async function account(name, role = "CLIENT") {
  const password = randomBytes(24).toString("hex");
  const result = await request(app).post("/api/v1/auth/register").set("Origin", "http://127.0.0.1:5173").set("X-FixIT-CSRF", "1").send({ email: name + suffix, name: `Synthetic ${name}`, role, password, passwordConfirmation: password,
    ...(role === "MASTER" ? { city, category: "OTHER", profileDescription: "Synthetic profile", serviceTitle: "Synthetic service", serviceDescription: "Synthetic description" } : {}) }).expect(201);
  const user = result.body.user;
  return { ...user, token: issueToken(user.id, options), profile: await database.masterProfile.findUnique({ where: { userId: user.id } }) };
}
const call = (actor, method, path) => request(app)[method](`/api/v1${path}`).set("Authorization", `Bearer ${actor.token}`);
const patch = (actor, id, status) => call(actor, "patch", `/master/orders/${id}/status`).send({ status });
const stored = (id) => database.order.findUniqueOrThrow({ where: { id } });
async function accepted() {
  const order = (await call(client, "post", "/orders").send({ title: "Synthetic lifecycle", description: "Local test data only", city, category: "OTHER" }).expect(201)).body.order;
  const response = (await call(master, "post", `/master/orders/${order.id}/responses`).send({ message: "Synthetic text offer" }).expect(201)).body.response;
  return (await call(client, "post", `/orders/${order.id}/select-response`).send({ responseId: response.id }).expect(200)).body.order;
}
function safeMasterDTO(order) {
  expect(JSON.stringify(order)).not.toMatch(/password|email|userId|clientId|isApproved|statusHistory|actorUserId/i);
}
beforeAll(async () => {
  await database.$connect(); client = await account("client"); otherClient = await account("other-client");
  master = await account("master", "MASTER"); otherMaster = await account("other-master", "MASTER");
});
afterAll(async () => {
  // Accepted offers and their committed history are retained only in *_test.
  await database.$disconnect();
});

describe("MASTER status endpoint permissions and input boundary", () => {
  test("missing JWT is 401", async () => {
    await request(app).patch(`/api/v1/master/orders/${randomUUID()}/status`).send({ status: "IN_PROGRESS" }).expect(401);
  });
  test.each(["invalid", "expired", "wrong-key"])("%s JWT is 401 and leaves state untouched", async (kind) => {
    const order = await accepted(); const before = await stored(order.id);
    const token = kind === "invalid" ? "invalid.token" : issueToken(master.id, { ...options, ...(kind === "expired" ? { tokenTtlSeconds: -10 } : { jwtSecret: randomBytes(48).toString("hex") }) });
    await patch({ token }, order.id, "IN_PROGRESS").expect(401); expect(await stored(order.id)).toEqual(before);
  });
  test("CLIENT owner cannot invoke MASTER PATCH", async () => {
    const order = await accepted(); await patch(client, order.id, "IN_PROGRESS").expect(403);
    expect((await stored(order.id)).status).toBe("ACCEPTED");
  });
  test("another MASTER cannot change an assigned order", async () => {
    const order = await accepted(); const before = await stored(order.id);
    await patch(otherMaster, order.id, "IN_PROGRESS").expect(403); expect(await stored(order.id)).toEqual(before);
  });
  test("internal ADMIN cannot use MASTER status endpoint", async () => {
    const user = await database.user.create({ data: { email: "admin" + suffix, name: "Synthetic internal", role: "ADMIN", passwordHash: "synthetic-unused-hash" } });
    await patch({ token: issueToken(user.id, options) }, randomUUID(), "IN_PROGRESS").expect(403);
  });
  test("deleted account is 401", async () => {
    await patch({ token: issueToken(randomUUID(), options) }, randomUUID(), "IN_PROGRESS").expect(401);
  });
  test("legacy MASTER without profile cannot change an order", async () => {
    const order = await accepted();
    const user = await database.user.create({ data: { email: "legacy" + suffix, name: "Synthetic legacy", role: "MASTER", passwordHash: "synthetic-unused-hash" } });
    await patch({ token: issueToken(user.id, options) }, order.id, "IN_PROGRESS").expect(403);
  });
  test.each([{}, { status: "UNKNOWN" }, { status: 1 }, { status: null }, { status: "in_progress" },
    { status: "IN_PROGRESS", masterProfileId: "spoof" }, { status: "IN_PROGRESS", userId: "spoof" },
    { status: "IN_PROGRESS", clientId: "spoof" }, { status: "IN_PROGRESS", statusHistory: [] }])("strict invalid payload %# is 400 without a write", async (body) => {
    const order = await accepted(); const before = await stored(order.id);
    await call(master, "patch", `/master/orders/${order.id}/status`).send(body).expect(400);
    expect(await stored(order.id)).toEqual(before);
  });
  test("malformed UUID is 400, unknown UUID is a safe 404", async () => {
    await patch(master, "not-a-uuid", "IN_PROGRESS").expect(400);
    const result = await patch(master, randomUUID(), "IN_PROGRESS").expect(404);
    expect(result.body.error.code).toBe("NOT_FOUND"); expect(JSON.stringify(result.body)).not.toMatch(/SELECT|stack|prisma/i);
  });
  test("identity cannot be supplied through query parameters", async () => {
    const order = await accepted(); await patch(master, order.id, "IN_PROGRESS").query({ userId: otherMaster.id }).expect(400);
    expect((await stored(order.id)).status).toBe("ACCEPTED");
  });
  test("CORS preflight permits PATCH only for configured frontend origin", async () => {
    const path = `/api/v1/master/orders/${randomUUID()}/status`;
    const preflight = await request(app).options(path).set("Origin", options.corsOrigins[0]).set("Access-Control-Request-Method", "PATCH").set("Access-Control-Request-Headers", "authorization,content-type").expect(204);
    expect(preflight.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(preflight.headers["access-control-allow-origin"]).toBe(options.corsOrigins[0]);
    await request(app).options(path).set("Origin", "https://untrusted.example").set("Access-Control-Request-Method", "PATCH").expect(403);
  });
});

describe("transactional lifecycle, history and CLIENT history", () => {
  test("ACCEPTED → IN_PROGRESS → COMPLETED persists exact history and real completion time", async () => {
    const order = await accepted(); const before = await stored(order.id);
    const started = (await patch(master, order.id, "IN_PROGRESS").expect(200)).body.order;
    expect(started).toMatchObject({ id: order.id, type: "CUSTOM", status: "IN_PROGRESS", completedAt: null }); safeMasterDTO(started);
    const inProgress = await stored(order.id);
    expect(inProgress.statusHistory).toEqual([...before.statusHistory, expect.objectContaining({ status: "IN_PROGRESS", actorUserId: master.id, source: "database" })]);
    const completed = (await patch(master, order.id, "COMPLETED").expect(200)).body.order; safeMasterDTO(completed);
    const final = await stored(order.id); const event = final.statusHistory.at(-1);
    expect(final.statusHistory.map((e) => e.status)).toEqual(["OPEN", "ACCEPTED", "IN_PROGRESS", "COMPLETED"]);
    expect(event).toMatchObject({ source: "database", actorUserId: master.id });
    expect(completed.completedAt).toBe(new Date(event.at).toISOString());
    expect(final.createdAt).toEqual(before.createdAt); expect(final.masterProfileId).toBe(before.masterProfileId);
    expect(await database.orderResponse.count({ where: { orderId: order.id } })).toBe(1);
    const clientOrder = (await call(client, "get", "/orders").expect(200)).body.orders.find((row) => row.id === order.id);
    expect(clientOrder).toMatchObject({ status: "COMPLETED", completedAt: completed.completedAt, assignedMaster: { id: master.profile.id } });
    const assigned = (await call(master, "get", "/master/orders/assigned").expect(200)).body.orders.find((row) => row.id === order.id);
    expect(assigned).toEqual(completed);
    expect((await call(otherClient, "get", "/orders")).body.orders.some((row) => row.id === order.id)).toBe(false);
  });
  test.each(["COMPLETED", "ACCEPTED", "OPEN", "PENDING", "CANCELLED", "DECLINED"])("ACCEPTED → %s is 409 with unchanged database history", async (status) => {
    const order = await accepted(); const before = await stored(order.id);
    await patch(master, order.id, status).expect(409); expect(await stored(order.id)).toEqual(before);
  });
  test.each(["IN_PROGRESS", "ACCEPTED", "CANCELLED", "DECLINED"])("IN_PROGRESS → %s is 409", async (status) => {
    const order = await accepted(); await patch(master, order.id, "IN_PROGRESS").expect(200); const before = await stored(order.id);
    await patch(master, order.id, status).expect(409); expect(await stored(order.id)).toEqual(before);
  });
  test.each(["COMPLETED", "CANCELLED"])("terminal %s cannot transition again", async (status) => {
    const order = await accepted();
    if (status === "COMPLETED") { await patch(master, order.id, "IN_PROGRESS").expect(200); await patch(master, order.id, "COMPLETED").expect(200); }
    else await call(client, "delete", `/orders/${order.id}`).expect(200);
    const before = await stored(order.id); await patch(master, order.id, status === "COMPLETED" ? "COMPLETED" : "IN_PROGRESS").expect(409);
    expect(await stored(order.id)).toEqual(before);
  });
  test.each(["IN_PROGRESS", "COMPLETED"])("CLIENT cancellation after %s is 409 without losing history", async (status) => {
    const order = await accepted(); await patch(master, order.id, "IN_PROGRESS").expect(200);
    if (status === "COMPLETED") await patch(master, order.id, "COMPLETED").expect(200);
    const before = await stored(order.id); await call(client, "delete", `/orders/${order.id}`).expect(409);
    expect(await stored(order.id)).toEqual(before);
    const row = (await call(client, "get", "/orders")).body.orders.find((r) => r.id === order.id); expect(row.status).toBe(status);
  });
  test("concurrent identical PATCH requests each commit once per lifecycle stage", async () => {
    const order = await accepted();
    for (const status of ["IN_PROGRESS", "COMPLETED"]) {
      const results = await Promise.all([patch(master, order.id, status), patch(master, order.id, status)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const current = await stored(order.id);
      expect(current.status).toBe(status); expect(current.statusHistory.filter((e) => e.status === status)).toHaveLength(1);
    }
    expect((await stored(order.id)).statusHistory).toHaveLength(4);
  });
  test("unassigned OPEN order cannot be started by an unrelated MASTER", async () => {
    const order = await commands.createCustom(client.id, { title: "Unassigned", description: "Synthetic", city, category: "OTHER" });
    await patch(master, order.id, "IN_PROGRESS").expect(403); expect((await stored(order.id)).status).toBe("OPEN");
  });
  test.each(["ACCEPTED", "DECLINED"])("future STANDARD PENDING → %s remains supported by the same transition API", async (status) => {
    // Real synthetic integration fixture only; no public STANDARD UI/US-04 added.
    const service = await database.service.findFirstOrThrow({ where: { masterProfileId: master.profile.id } });
    const order = await commands.createStandard(client.id, { serviceId: service.id, masterProfileId: master.profile.id, description: "Synthetic future compatibility" });
    const result = (await patch(master, order.id, status).expect(200)).body.order;
    expect(result).toMatchObject({ type: "STANDARD", status, completedAt: null }); safeMasterDTO(result);
    expect((await stored(order.id)).statusHistory.map((e) => e.status)).toEqual(["PENDING", status]);
    await patch(master, order.id, status).expect(409);
  });
});
