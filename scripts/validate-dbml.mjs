import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { Parser, exporter } = require("@dbml/core");
const source = readFileSync("docs/er-diagram.dbml", "utf8");
const database = Parser.parse(source, "dbmlv2");
const tables = database.schemas.flatMap((schema) => schema.tables);
if (tables.length !== 4 || tables.map((table) => table.name).sort().join(",") !== "master_profiles,orders,services,users") {
  throw new Error("DBML must contain the four MVP tables.");
}
// A one-to-one DBML Ref puts the FK on its second endpoint. Verify the
// exported direction, rather than accepting a diagram that merely parses.
const sql = exporter.export(source, "postgres");
for (const [child, field, parent] of [
  ["master_profiles", "user_id", "users"],
  ["services", "master_profile_id", "master_profiles"],
  ["orders", "client_id", "users"],
  ["orders", "service_id", "services"],
]) {
  assert.ok(sql.includes(`ALTER TABLE "${child}" ADD CONSTRAINT "${child}_${field}_fkey" FOREIGN KEY ("${field}") REFERENCES "${parent}" ("id") ON DELETE RESTRICT ON UPDATE CASCADE`), `Incorrect DBML FK: ${child}.${field}`);
}
console.log("DBML valid: 4 tables; all 4 FK directions and delete/update policies verified.");
