import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { Parser, exporter } = require("@dbml/core");
const source = readFileSync("docs/er-diagram.dbml", "utf8");
const database = Parser.parse(source, "dbmlv2");
const tables = database.schemas.flatMap((schema) => schema.tables);
if (
  tables.length !== 6 ||
  tables
    .map((table) => table.name)
    .sort()
    .join(",") !== "auth_sessions,master_profiles,order_responses,orders,services,users"
) {
  throw new Error("DBML must contain five business tables plus auth_sessions.");
}
// A one-to-one DBML Ref puts the FK on its second endpoint. Verify the
// exported direction, rather than accepting a diagram that merely parses.
const sql = exporter.export(source, "postgres");
for (const [child, field, parent] of [
  ["master_profiles", "user_id", "users"],
  ["services", "master_profile_id", "master_profiles"],
  ["orders", "client_id", "users"],
]) {
  assert.ok(
    sql.includes(
      `ALTER TABLE "${child}" ADD CONSTRAINT "${child}_${field}_fkey" FOREIGN KEY ("${field}") REFERENCES "${parent}" ("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    ),
    `Incorrect DBML FK: ${child}.${field}`,
  );
}
for (const [child, field, parent] of [
  ["orders", "master_profile_id", "master_profiles"],
  ["order_responses", "order_id", "orders"],
  ["order_responses", "master_profile_id", "master_profiles"],
]) {
  assert.ok(
    sql.includes(
      `ALTER TABLE "${child}" ADD CONSTRAINT "${child}_${field}_fkey" FOREIGN KEY ("${field}") REFERENCES "${parent}" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
    ),
  );
}
assert.ok(
  sql.includes(
    'FOREIGN KEY ("service_id", "master_profile_id") REFERENCES "services" ("id", "master_profile_id")',
  ),
);
console.log(
  "DBML valid: 5 business tables + auth_sessions; 8 FK, including STANDARD composite ownership.",
);
assert.ok(sql.includes('FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE'));
