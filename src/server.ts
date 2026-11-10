import type { Server } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { checkDatabase, createDatabaseClient } from "./database/client.js";

async function main() {
  const config = loadConfig();
  const database = createDatabaseClient(config.databaseUrl);
  let server: Server | undefined;

  try {
    await database.$connect();
    await checkDatabase(database);
    const app = createApp(() => checkDatabase(database), {
      database,
      ...config,
    });
    await new Promise<void>((resolve, reject) => {
      server = app.listen(config.port, config.host, (error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
      server.once("error", reject);
    });
    console.log(
      `FixIT backend listening on ${config.host}:${config.port}; database connected.`,
    );
  } catch {
    await database.$disconnect();
    throw new Error(
      "Backend startup failed. Check DATABASE_URL, PostgreSQL availability and the listen address/port. Credentials are hidden.",
    );
  }

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10000).unref();
    server?.close(async () => {
      try {
        await database.$disconnect();
        clearTimeout(deadline);
        process.exitCode = 0;
      } catch {
        process.exitCode = 1;
      }
    });
  }
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
}

main().catch((error: unknown) => {
  // Only our deliberately redacted configuration/startup errors are exposed.
  console.error(
    error instanceof Error ? error.message : "Backend startup failed.",
  );
  process.exitCode = 1;
});
