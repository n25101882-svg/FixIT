import { spawnSync } from "node:child_process";

// A standalone E2E command must build the real same-origin production artifact,
// independently of a developer's local VITE_API_URL. This creates no resources.
if (!process.env.npm_execpath) throw new Error("Run session frontend build through npm scripts.");
const result = spawnSync(process.execPath, [process.env.npm_execpath, "run", "frontend:build"], {
  env: { ...process.env, NODE_ENV: "production", VITE_API_URL: "/api/v1" }, stdio: "inherit",
});
process.exitCode = result.status ?? 1;
