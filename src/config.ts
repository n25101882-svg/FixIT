import { config } from "dotenv";

config({ quiet: true });

export function requireDatabaseUrl(value = process.env.DATABASE_URL): string {
  if (!value) throw new Error("DATABASE_URL is required.");
  try {
    const url = new URL(value);
    if (
      !["postgresql:", "postgres:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length <= 1
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      "DATABASE_URL must be a valid PostgreSQL URL (value hidden).",
    );
  }
  return value;
}

export function requireLocalTestDatabase(value: string | undefined): string {
  if (!value)
    throw new Error("An explicit local test database URL is required.");
  const result = requireDatabaseUrl(value);
  const url = new URL(result);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^[a-z][a-z0-9_]*_test$/.test(name)
  ) {
    throw new Error(
      "Seeder/integration tests require a loopback database with a name ending in _test.",
    );
  }
  // libpq routing via connection-string parameters must not override loopback.
  for (const key of url.searchParams.keys()) {
    if (key !== "schema")
      throw new Error(
        "Test database URL permits only the schema query parameter.",
      );
  }
  return result;
}

export function loadConfig() {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return {
    databaseUrl: requireDatabaseUrl(),
    host: process.env.HOST ?? "127.0.0.1",
    port,
    ...loadAuthConfig(),
  };
}

export function loadAuthConfig() {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || Buffer.byteLength(jwtSecret, "utf8") < 32) {
    throw new Error(
      "JWT_SECRET must be supplied through the environment with at least 32 bytes.",
    );
  }
  const tokenTtlSeconds = Number(process.env.JWT_TTL_SECONDS ?? 900);
  if (
    !Number.isInteger(tokenTtlSeconds) ||
    tokenTtlSeconds < 60 ||
    tokenTtlSeconds > 86400
  ) {
    throw new Error("JWT_TTL_SECONDS must be an integer between 60 and 86400.");
  }
  const corsOrigins = (
    process.env.CORS_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173"
  )
    .split(",")
    .map((v) => v.trim());
  if (
    !corsOrigins.length ||
    corsOrigins.some((origin) => {
      try {
        const url = new URL(origin);
        return (
          !["http:", "https:"].includes(url.protocol) || url.origin !== origin
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error(
      "CORS_ORIGINS must contain exact HTTP(S) origins, without wildcard or paths.",
    );
  return { jwtSecret, tokenTtlSeconds, corsOrigins };
}
