import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "@jest/globals";
import request from "supertest";
import { loadConfig } from "../dist/config.js";
import { createApp } from "../dist/app.js";
import { validateApiDeployment, validateFrontendDeployment } from "../scripts/deployment-config.mjs";
import { validateBlueprint } from "../scripts/check-render-blueprint.mjs";

// Synthetic validation fixtures only. No function in this suite opens a DB or
// contacts Render; the rate-limit test fails validation before database access.
const secret = "synthetic-deployment-unit-fixture-" + "a".repeat(32);
const localDatabase = "postgresql://synthetic:unused@127.0.0.1:55432/fixit_release_test";
const apiEnv = () => ({ NODE_ENV: "production", HOST: "0.0.0.0", PORT: "10000", TRUST_PROXY_HOPS: "1", SERVE_FRONTEND: "1", VITE_API_URL: "/api/v1", JWT_SECRET: secret,
  DATABASE_URL: "postgresql://synthetic:unused@dpg-synthetic-a/fixit", CORS_ORIGINS: "https://fixit-web.onrender.com", JWT_TTL_SECONDS: "900" });
const webEnv = () => ({ VITE_API_URL: "/api/v1" });
function cli(script, args, env, withLocalEnv = false) {
  const directory = mkdtempSync(join(tmpdir(), "fixit-deployment-guard-"));
  try {
    mkdirSync(join(directory, "frontend"));
    if (withLocalEnv) writeFileSync(join(directory, ".env"), "SYNTHETIC_ONLY=unused\n");
    return spawnSync(process.execPath, [resolve(script), ...args], { cwd: directory, env: { ...process.env, ...env }, encoding: "utf8" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function configured(changes) {
  const before = new Map(Object.keys(changes).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(changes)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    return loadConfig();
  } finally {
    for (const [key, value] of before) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
describe("bounded proxy and platform HTTP configuration", () => {
  const common = { DATABASE_URL: localDatabase, JWT_SECRET: secret, CORS_ORIGINS: "http://127.0.0.1:5173" };
  test("local/direct traffic still trusts no proxy", () => {
    expect(configured({ ...common, TRUST_PROXY_HOPS: undefined, HOST: undefined, PORT: undefined })).toMatchObject({ host: "127.0.0.1", port: 3000, trustProxyHops: 0 });
    expect(createApp(async () => {}).get("trust proxy")).toBe(false);
  });
  test("platform HOST/PORT and explicit one-hop trust are used", () => {
    expect(configured({ ...common, HOST: "0.0.0.0", PORT: "10000", TRUST_PROXY_HOPS: "1" })).toMatchObject({ host: "0.0.0.0", port: 10000, trustProxyHops: 1 });
  });
  test("production access lifetime cannot be extended beyond the 15-minute decision", () => {
    expect(() => configured({ ...common, NODE_ENV: "production", JWT_TTL_SECONDS: "1800" })).toThrow("900 seconds");
  });
  test.each(["true", "2", "-1", "1.5", "", "loopback"])("unbounded/invalid proxy setting %# fails", (value) => {
    expect(() => configured({ ...common, TRUST_PROXY_HOPS: value })).toThrow("TRUST_PROXY_HOPS");
  });
  test("one trusted ingress keeps independent auth rate limits by forwarded client", async () => {
    const app = createApp(async () => {}, { database: {}, jwtSecret: secret, tokenTtlSeconds: 900, corsOrigins: ["http://127.0.0.1:5173"], rateLimit: { limit: 1, windowMs: 60000 } }, { trustProxyHops: 1 });
    await request(app).post("/api/v1/auth/login").set("Origin", "http://127.0.0.1:5173").set("X-FixIT-CSRF", "1").set("X-Forwarded-For", "192.0.2.10").send({}).expect(400);
    await request(app).post("/api/v1/auth/login").set("Origin", "http://127.0.0.1:5173").set("X-FixIT-CSRF", "1").set("X-Forwarded-For", "192.0.2.11").send({}).expect(400);
    await request(app).post("/api/v1/auth/login").set("Origin", "http://127.0.0.1:5173").set("X-FixIT-CSRF", "1").set("X-Forwarded-For", "192.0.2.10").send({}).expect(429);
    expect(app.get("trust proxy")).toBe(1);
  });
});

describe("deployment preflight rejects unsafe configuration without logging values", () => {
  test("Render internal DB / exact HTTPS origin and public frontend API pass", () => {
    expect(() => validateApiDeployment(apiEnv())).not.toThrow(); expect(() => validateFrontendDeployment(webEnv())).not.toThrow();
  });
  test("external DB requires verified TLS, loopback rehearsal uses a dedicated *_test", () => {
    expect(() => validateApiDeployment({ ...apiEnv(), DATABASE_URL: "postgresql://synthetic:unused@db.example.test/fixit?sslmode=verify-full" })).not.toThrow();
    expect(() => validateApiDeployment({ ...apiEnv(), DATABASE_URL: localDatabase + "?schema=public" })).not.toThrow();
    expect(() => validateApiDeployment({ ...apiEnv(), DATABASE_URL: "postgresql://synthetic:unused@db.example.test/fixit" })).toThrow("verified TLS");
  });
  test.each([
    { NODE_ENV: "development" }, { HOST: "127.0.0.1" }, { TRUST_PROXY_HOPS: "true" }, { PORT: "" }, { PORT: "65536" }, { PORT: "NaN" },
    { JWT_SECRET: "" }, { JWT_SECRET: "short" }, { JWT_SECRET: "CHANGE_ME".repeat(8) }, { JWT_TTL_SECONDS: "86401" },
    { CORS_ORIGINS: "" }, { CORS_ORIGINS: "*" }, { CORS_ORIGINS: "https://fixit-web.onrender.com/" }, { CORS_ORIGINS: "http://localhost:5173" },
    { DATABASE_URL: "" }, { DATABASE_URL: "not-a-secret-valid-url" }, { DATABASE_URL: "postgresql://synthetic:unused@127.0.0.1/fixit_dev" },
    { DATABASE_URL: "postgresql://synthetic:unused@127.0.0.1/fixit_test" }, { DATABASE_URL: "postgresql://synthetic:unused@127.0.0.1/fixit_shadow" },
    { DATABASE_URL: "postgresql://synthetic:CHANGE_ME@dpg-synthetic-a/fixit" },
    { DATABASE_URL: "postgresql://synthetic:unused@dpg-synthetic-a/fixit?sslmode=no-verify" },
    { DATABASE_URL: "postgresql://synthetic:unused@dpg-synthetic-a/fixit?sslmode=verify-full&sslmode=disable" },
    { DATABASE_URL: "postgresql://synthetic:unused@dpg-synthetic-a/fixit?host=outside.example" },
    { DATABASE_URL: "postgresql://synthetic:unused@dpg-synthetic-a/fixit?schema=other" },
    { TEST_DATABASE_URL: localDatabase }, { SHADOW_DATABASE_URL: localDatabase }, { CLEAN_DATABASE_URL: localDatabase }, { UPGRADE_DATABASE_URL: localDatabase },
  ])("unsafe API binding %# fails with a redacted error", (change) => {
    expect(() => validateApiDeployment({ ...apiEnv(), ...change })).toThrow();
    try { validateApiDeployment({ ...apiEnv(), ...change }); } catch (error) {
      expect(error.message).not.toContain(secret); expect(error.message).not.toMatch(/postgresql:\/\//);
    }
  });
  test.each(["", "http://127.0.0.1:3000/api/v1", "https://172.16.0.1/api/v1", "https://api.internal/api/v1", "https://api.example.test", "https://api.example.test/api/v1?token=private", "https://synthetic:unused@api.example.test/api/v1"])("unsafe frontend URL %# fails", (value) => {
    expect(() => validateFrontendDeployment({ VITE_API_URL: value })).toThrow("VITE_API_URL");
  });
  test("frontend VITE_ secret binding is rejected", () => { expect(() => validateFrontendDeployment({ ...webEnv(), VITE_JWT_SECRET: secret })).toThrow("Only the public"); });
  test.each([{ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { npm_config_strict_ssl: "false" }, { NPM_CONFIG_STRICT_SSL: "false" }, { PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING: "1" }, { PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING: "0" }])("transport override %# is rejected by both deploy guards", (change) => {
    expect(() => validateApiDeployment({ ...apiEnv(), ...change })).toThrow("verification");
    expect(() => validateFrontendDeployment({ ...webEnv(), ...change })).toThrow("verification");
  });
  test("CLI missing frontend binding fails before a build", () => {
    const run = cli("scripts/check-deploy-env.mjs", ["frontend"], { VITE_API_URL: "" });
    expect(run.status).toBe(1); expect(run.stderr).toContain("VITE_API_URL"); expect(run.stdout).toBe("");
  });
  test("deployment CLI refuses developer dotenv files before building or migrating", () => {
    const run = cli("scripts/check-deploy-env.mjs", ["frontend"], webEnv(), true);
    expect(run.status).toBe(1); expect(run.stderr).toContain("no local .env files");
  });
  test.each(["fixit_test", "fixit_shadow", "fixit_dev"])("release guard never targets reserved %s", (name) => {
    const value = new URL(localDatabase); value.pathname = "/" + name;
    const run = cli("scripts/check-release-test-env.mjs", [], { DATABASE_URL: value.href, TEST_DATABASE_URL: value.href });
    expect(run.status).toBe(1); expect(run.stdout).toBe(""); expect(run.stderr).not.toContain("postgresql://");
  });
  test("release guard refuses mismatched or remote verification targets", () => {
    for (const other of [localDatabase + "_other", "postgresql://synthetic:unused@db.example.test/fixit_release_test"]) {
      const run = cli("scripts/check-release-test-env.mjs", [], { DATABASE_URL: localDatabase, TEST_DATABASE_URL: other });
      expect(run.status).toBe(1); expect(run.stdout).toBe("");
    }
  });
});

describe("Render blueprint local safety invariants", () => {
  const blueprint = () => JSON.parse(readFileSync("render.yaml", "utf8"));
  test("free single-origin service, explicit bindings, migration startup and no autodeploy", () => { expect(() => validateBlueprint(blueprint())).not.toThrow(); });
  test('PostgreSQL version is the Render-required string "18", never numeric 18', () => {
    const data = blueprint();
    expect(data.databases[0].postgresMajorVersion).toBe("18");
    expect(() => validateBlueprint(data)).not.toThrow();
    data.databases[0].postgresMajorVersion = 18;
    expect(() => validateBlueprint(data)).toThrow("postgresMajorVersion to be a string");
  });
  test.each(["paid-api", "paid-db", "paid-static", "auto-deploy", "pre-deploy", "public-db", "leaked-secret", "frontend-secret", "missing-spa", "wrong-pg", "duplicate-binding"])("unsafe Blueprint change %s fails locally", (kind) => {
    const data = blueprint(), api = data.services[0];
    if (kind === "paid-api") api.plan = "starter";
    if (kind === "paid-db") data.databases[0].plan = "basic-256mb";
    if (kind === "paid-static") data.services.push({ runtime: "static", plan: "starter" });
    if (kind === "auto-deploy") api.autoDeployTrigger = "commit";
    if (kind === "pre-deploy") api.preDeployCommand = "npm run db:migrate";
    if (kind === "public-db") data.databases[0].ipAllowList = [{ source: "0.0.0.0/0" }];
    if (kind === "leaked-secret") api.envVars.find((item) => item.key === "JWT_SECRET").value = secret;
    if (kind === "frontend-secret") api.envVars.push({ key: "VITE_JWT_SECRET", value: secret });
    if (kind === "missing-spa") api.envVars.find((item) => item.key === "SERVE_FRONTEND").value = "0";
    if (kind === "wrong-pg") data.databases[0].postgresMajorVersion = "17";
    if (kind === "duplicate-binding") api.envVars.push(api.envVars[0]);
    expect(() => validateBlueprint(data)).toThrow();
  });
});
