import { requireLocalTestDatabase } from "../dist/config.js";

try {
  const database = requireLocalTestDatabase(process.env.DATABASE_URL);
  const test = requireLocalTestDatabase(process.env.TEST_DATABASE_URL);
  if (database !== test) throw new Error("Release verification requires the same isolated DATABASE_URL and TEST_DATABASE_URL.");
  for (const value of [database, test]) {
    const name = new URL(value).pathname.slice(1);
    if (["fixit_test", "fixit_shadow"].includes(name)) throw new Error("Reserved existing databases must not be used for release verification.");
  }
  console.log("Release verification uses an allowed loopback *_test database (values hidden).");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid test bindings (values hidden).");
  process.exitCode = 1;
}
