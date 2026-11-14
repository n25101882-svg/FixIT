import { requireDatabaseUrl } from "../src/config.js";
import { checkDatabase, createDatabaseClient } from "../src/database/client.js";
import assert from "node:assert/strict";

async function main() {
  const database = createDatabaseClient(requireDatabaseUrl());
  try {
    await database.$connect();
    await checkDatabase(database);
    const result = await database.$queryRaw<
      { database: string; version: string }[]
    >`
      SELECT current_database() AS database, current_setting('server_version') AS version
    `;
    console.log("PostgreSQL connection OK:", result[0]);
    const tables = await database.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema='public'
        AND table_type='BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name
    `;
    assert.deepEqual(
      tables.map((row) => row.table_name),
      ["master_profiles", "order_responses", "orders", "services", "users"],
    );
    const migrations = await database.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name
    `;
    for (const name of [
      "20261109200000_init_database_schema",
      "20261114130000_hybrid_mvp",
      "20261114150000_review_snapshot_alignment",
    ]) assert.ok(migrations.some((row) => row.migration_name === name), `Missing migration: ${name}`);
    console.log(
      "Hybrid schema OK: five business tables and all three applied migrations.",
    );
  } finally {
    await database.$disconnect();
  }
}

main().catch(() => {
  console.error(
    "PostgreSQL connection failed. Check the local DATABASE_URL and server (credentials hidden).",
  );
  process.exitCode = 1;
});
