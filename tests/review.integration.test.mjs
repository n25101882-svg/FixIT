import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, afterAll, describe, expect, test } from "@jest/globals";
import pg from "pg";
import { requireLocalTestDatabase } from "../dist/config.js";
import { createDatabaseClient } from "../dist/database/client.js";
import { seedDatabase, seedIds as ids } from "../dist/database/seed.js";
import { createOrderService } from "../dist/orders/service.js";

const url = requireLocalTestDatabase(process.env.TEST_DATABASE_URL);
const database = createDatabaseClient(url);
const sql = new pg.Client({ connectionString: url });
const problem = { title: "Original problem", city: "Original city", category: "OTHER", description: "Original description" };
const changes = [
  ["title", "Changed title"],
  ["city", "Changed city"],
  ["category", "ELECTRICAL"],
  ["description", "Changed description"],
  ["budget", "12.34"],
];

beforeAll(async () => {
  await database.$connect();
  await seedDatabase(database);
  await sql.connect();
});
afterAll(async () => {
  await sql.end();
  await database.$disconnect();
});

async function rollback(action) {
  const abort = new Error("intentional rollback");
  try {
    await database.$transaction(async (tx) => { await action(tx); throw abort; });
  } catch (error) {
    if (error !== abort) throw error;
  }
}
const commandsFor = (tx) => createOrderService({ $transaction: (callback) => callback(tx) });
async function createOrder(tx, type) {
  const commands = commandsFor(tx);
  return type === "STANDARD"
    ? commands.createStandard(ids.clientA, { serviceId: ids.serviceA, masterProfileId: ids.profileA, description: problem.description })
    : commands.createCustom(ids.clientA, { ...problem, budget: "50.00" });
}

describe.each(["STANDARD", "CUSTOM"])("%s content snapshots", (type) => {
  test.each(changes)("direct SQL rejects a change to %s and preserves the complete row", async (field, value) => {
    await sql.query("BEGIN");
    try {
      const created = (await sql.query(
        `INSERT INTO orders(client_id,type,status,service_id,master_profile_id,title,city,category,description,budget)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [ids.clientA, type, type === "STANDARD" ? "PENDING" : "OPEN",
          type === "STANDARD" ? ids.serviceA : null, type === "STANDARD" ? ids.profileA : null,
          problem.title, problem.city, problem.category, problem.description, type === "CUSTOM" ? "50.00" : null],
      )).rows[0];
      const before = (await sql.query("SELECT to_jsonb(o) AS value FROM orders o WHERE id=$1", [created.id])).rows[0].value;
      expect(before.status).toBe(type === "STANDARD" ? "PENDING" : "OPEN");
      await sql.query("SAVEPOINT rejected_edit");
      // field comes only from the fixed test cases above, never external input.
      await expect(sql.query(`UPDATE orders SET ${field}=$1 WHERE id=$2`, [value, created.id]))
        .rejects.toMatchObject({ code: "23514", message: "Order content snapshots are immutable" });
      await sql.query("ROLLBACK TO SAVEPOINT rejected_edit");
      expect((await sql.query("SELECT to_jsonb(o) AS value FROM orders o WHERE id=$1", [created.id])).rows[0].value).toEqual(before);
    } finally {
      await sql.query("ROLLBACK");
    }
  });

  test.each(changes)("Prisma rejects a change to %s and preserves timestamps/history", async (field, value) => {
    await rollback(async (tx) => {
      const before = await createOrder(tx, type);
      await tx.$executeRawUnsafe("SAVEPOINT rejected_edit");
      await expect(tx.order.update({ where: { id: before.id }, data: { [field]: value } }))
        .rejects.toThrow("Order content snapshots are immutable");
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT rejected_edit");
      expect(await tx.order.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    });
  });

  test("same-value content updates and normal status changes remain allowed", async () => {
    await rollback(async (tx) => {
      const before = await createOrder(tx, type);
      const { title, city, category, description, budget } = before;
      const same = await tx.order.update({ where: { id: before.id }, data: { title, city, category, description, budget } });
      expect(same.statusHistory).toEqual(before.statusHistory);
      const changed = await commandsFor(tx).transition(ids.clientA, { orderId: before.id, status: "CANCELLED" });
      expect(changed.statusHistory).toHaveLength(2);
      expect({ title: changed.title, city: changed.city, category: changed.category, description: changed.description, budget: changed.budget })
        .toEqual({ title, city, category, description, budget });
    });
  });
});

test("SQL snapshot violation rolls back earlier writes in the transaction", async () => {
  const beforeOrder = (await sql.query("SELECT to_jsonb(o) AS value FROM orders o WHERE id=$1", [ids.orderA])).rows[0].value;
  const beforeService = (await sql.query("SELECT title FROM services WHERE id=$1", [ids.serviceA])).rows[0].title;
  await sql.query("BEGIN");
  try {
    await sql.query("UPDATE services SET title='Must roll back' WHERE id=$1", [ids.serviceA]);
    await expect(sql.query("UPDATE orders SET title='Must fail' WHERE id=$1", [ids.orderA]))
      .rejects.toMatchObject({ code: "23514", message: "Order content snapshots are immutable" });
  } finally {
    await sql.query("ROLLBACK");
  }
  expect((await sql.query("SELECT title FROM services WHERE id=$1", [ids.serviceA])).rows[0].title).toBe(beforeService);
  expect((await sql.query("SELECT to_jsonb(o) AS value FROM orders o WHERE id=$1", [ids.orderA])).rows[0].value).toEqual(beforeOrder);
});

test("Prisma snapshot violation rolls back earlier writes in the transaction", async () => {
  const beforeOrder = await database.order.findUniqueOrThrow({ where: { id: ids.customOrder } });
  const beforeService = await database.service.findUniqueOrThrow({ where: { id: ids.serviceA } });
  await expect(database.$transaction(async (tx) => {
    await tx.service.update({ where: { id: ids.serviceA }, data: { title: "Must roll back" } });
    await tx.order.update({ where: { id: ids.customOrder }, data: { description: "Must fail" } });
  })).rejects.toThrow("Order content snapshots are immutable");
  expect(await database.service.findUniqueOrThrow({ where: { id: ids.serviceA } })).toEqual(beforeService);
  expect(await database.order.findUniqueOrThrow({ where: { id: ids.customOrder } })).toEqual(beforeOrder);
});

test("STANDARD may use an unpriced service; later pricing cannot rewrite its null snapshot", async () => {
  await rollback(async (tx) => {
    await tx.service.update({ where: { id: ids.serviceA }, data: { priceEstimate: null, description: null } });
    const order = await createOrder(tx, "STANDARD");
    expect(order.priceAtOrder).toBeNull();
    await tx.service.update({ where: { id: ids.serviceA }, data: { priceEstimate: "12.34" } });
    expect((await tx.order.findUniqueOrThrow({ where: { id: order.id } })).priceAtOrder).toBeNull();
  });
});

test("a text-only CUSTOM response can be selected atomically without a price", async () => {
  await rollback(async (tx) => {
    const commands = commandsFor(tx);
    const order = await createOrder(tx, "CUSTOM");
    await tx.masterProfile.update({ where: { id: ids.profileA }, data: { city: order.city, category: order.category } });
    const response = await commands.respond(ids.masterA, { orderId: order.id, message: "Inspection needed before estimating" });
    expect(response.proposedPrice).toBeNull();
    const selected = await commands.selectResponse(ids.clientA, { orderId: order.id, responseId: response.id });
    expect(selected.masterProfileId).toBe(ids.profileA);
    expect(selected.status).toBe("ACCEPTED");
    expect(selected.priceAtOrder).toBeNull();
    expect(selected.budget.toFixed(2)).toBe("50.00");
    expect(selected.statusHistory).toHaveLength(2);
  });
});

test.each(["-0.01", "100000000.00", "NaN"])("CUSTOM budget rejects %s in SQL and at the command boundary", async (budget) => {
  await expect(rollback((tx) => tx.order.create({ data: { ...problem, clientId: ids.clientA, type: "CUSTOM", status: "OPEN", budget } }))).rejects.toThrow();
  await expect(Promise.resolve().then(() => createOrderService(database).createCustom(ids.clientA, { ...problem, budget })))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
});

test("only the client can cancel before work; neither actor can cancel IN_PROGRESS", async () => {
  await rollback(async (tx) => {
    const commands = commandsFor(tx);
    const order = await createOrder(tx, "STANDARD");
    await commands.transition(ids.masterA, { orderId: order.id, status: "ACCEPTED" });
    await expect(commands.transition(ids.masterA, { orderId: order.id, status: "CANCELLED" })).rejects.toMatchObject({ code: "CONFLICT" });
    await commands.transition(ids.masterA, { orderId: order.id, status: "IN_PROGRESS" });
    for (const id of [ids.clientA, ids.masterA])
      await expect(commands.transition(id, { orderId: order.id, status: "CANCELLED" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(tx.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } })).rejects.toThrow("Invalid order status transition");
  });
});

// Persistence capability only: FIX-1 registration/Auth remains in the future integration of PR #2.
async function masterRecords(tx, userId, profileId, priceEstimate) {
  await tx.user.create({ data: { id: userId, email: `${userId}@atomic.fixit.test`, name: "Synthetic master", role: "MASTER", passwordHash: (await tx.user.findUniqueOrThrow({ where: { id: ids.masterA } })).passwordHash } });
  await tx.masterProfile.create({ data: { id: profileId, userId, city: "Synthetic city", category: "OTHER", description: "Synthetic master description" } });
  return tx.service.create({ data: { masterProfileId: profileId, title: "First service", category: "OTHER", description: "First service description", priceEstimate } });
}
test("DB supports creating User + MasterProfile + first Service together without requiring price", async () => {
  await rollback(async (tx) => {
    const userId = randomUUID(), profileId = randomUUID();
    const service = await masterRecords(tx, userId, profileId, null);
    expect(service.priceEstimate).toBeNull();
    expect(await tx.user.count({ where: { id: userId } })).toBe(1);
    expect(await tx.masterProfile.count({ where: { id: profileId } })).toBe(1);
  });
});
test("failure creating the first Service rolls back User + MasterProfile too (DB-level integration prerequisite)", async () => {
  const userId = randomUUID(), profileId = randomUUID();
  await expect(database.$transaction((tx) => masterRecords(tx, userId, profileId, "-0.01"))).rejects.toThrow("services_price_estimate_check");
  expect(await database.user.count({ where: { id: userId } })).toBe(0);
  expect(await database.masterProfile.count({ where: { id: profileId } })).toBe(0);
  expect(await database.service.count({ where: { masterProfileId: profileId } })).toBe(0);
});

test("DBML agrees with actual migrated columns, types, lengths and nullability for every table", async () => {
  const require = createRequire(import.meta.url);
  const { Parser } = require("@dbml/core");
  const model = Parser.parse(readFileSync("docs/er-diagram.dbml", "utf8"), "dbmlv2");
  for (const table of model.schemas.flatMap((schema) => schema.tables)) {
    const columns = (await sql.query(
      "SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attname", [table.name],
    )).rows;
    const normalize = (type) => type.replace(/^varchar/, "character varying").replace(/^decimal/, "numeric").replace(/^timestamptz\((\d+)\)/, "timestamp($1) with time zone").replace(/^boolean$/, "boolean");
    expect(columns).toEqual(table.fields.map((field) => ({ name: field.name, type: normalize(field.type.type_name), not_null: !!field.not_null })).sort((a,b) => a.name.localeCompare(b.name)));
  }
});
