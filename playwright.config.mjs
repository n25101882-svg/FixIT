import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";
import { requireLocalTestDatabase } from "./dist/config.js";

const databaseUrl = requireLocalTestDatabase(process.env.TEST_DATABASE_URL);
const frontend = "http://127.0.0.1:5174";
const backend = "http://127.0.0.1:4100";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: [
    ["list"],
    ["json", { outputFile: process.argv.includes("--grep-invert") ? "test-results/e2e-regression-results.json"
      : process.argv.includes("@sessions") ? "test-results/e2e-sessions-results.json"
      : process.argv.includes("@details") ? "test-results/e2e-details-results.json"
      : process.argv.includes("@standard") ? "test-results/e2e-standard-results.json"
      : process.argv.includes("@catalog") ? "test-results/e2e-catalog-results.json"
      : process.argv.includes("@lifecycle") ? "test-results/e2e-lifecycle-results.json" : "test-results/e2e-results.json" }],
  ],
  use: {
    baseURL: frontend,
    headless: true,
    // Do not record access tokens/passwords in traces or videos.
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox"],
    },
  },
  webServer: [
    {
      command: "npm run dev",
      url: `${backend}/health/ready`,
      timeout: 30000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        JWT_SECRET: randomBytes(48).toString("hex"),
        CORS_ORIGINS: frontend,
        HOST: "127.0.0.1",
        PORT: "4100",
      },
    },
    {
      command: "npm run frontend:dev -- --port 5174",
      url: frontend,
      timeout: 30000,
      reuseExistingServer: false,
      env: { ...process.env, VITE_API_URL: `${backend}/api/v1` },
    },
  ],
});
