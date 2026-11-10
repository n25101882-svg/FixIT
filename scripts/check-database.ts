import { requireDatabaseUrl } from "../src/config.js";
import { checkDatabase, createDatabaseClient } from "../src/database/client.js";

async function main() {
  const database = createDatabaseClient(requireDatabaseUrl());
  try {
    await database.$connect();
    await checkDatabase(database);
    const result = await database.$queryRaw<{ database: string; version: string }[]>`
      SELECT current_database() AS database, current_setting('server_version') AS version
    `;
    console.log("PostgreSQL connection OK:", result[0]);
  } finally {
    await database.$disconnect();
  }
}

main().catch(() => {
  console.error("PostgreSQL connection failed. Check the local DATABASE_URL and server (credentials hidden).");
  process.exitCode = 1;
});
