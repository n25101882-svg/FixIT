import { requireLocalTestDatabase } from "../src/config.js";
import { createDatabaseClient } from "../src/database/client.js";
import { seedDatabase } from "../src/database/seed.js";

async function main() {
  const database = createDatabaseClient(requireLocalTestDatabase(process.env.DATABASE_URL));
  try {
    const fixtures = await seedDatabase(database);
    console.log("Synthetic seed complete (fixture counts, not total database rows):", fixtures);
  } finally {
    await database.$disconnect();
  }
}

main().catch(() => {
  console.error("Seed failed. Use a migrated local *_test database; no credential values are logged.");
  process.exitCode = 1;
});
