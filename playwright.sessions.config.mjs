import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config.mjs";
import { requireLocalTestDatabase } from "./dist/config.js";

const databaseUrl = requireLocalTestDatabase(process.env.TEST_DATABASE_URL);
// Ephemeral runner/server key, never embedded in frontend or written to Git.
const secret = process.env.FIXIT_BROWSER_JWT_SECRET ?? randomBytes(48).toString("hex");
process.env.FIXIT_BROWSER_JWT_SECRET = secret;
const origin = "http://localhost:4200";
export default defineConfig({
  ...base,
  testMatch: "sessions.spec.ts",
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-sessions-results.json" }]],
  use: { ...base.use, baseURL: origin },
  webServer: [{ command: "npm start", url: `${origin}/health/ready`, timeout: 30000, reuseExistingServer: false,
    env: { ...process.env, NODE_ENV: "production", DATABASE_URL: databaseUrl, JWT_SECRET: secret,
      CORS_ORIGINS: origin, SERVE_FRONTEND: "1", HOST: "127.0.0.1", PORT: "4200" } }],
});
