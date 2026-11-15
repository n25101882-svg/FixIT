import { readdirSync } from "node:fs";
import { validateApiDeployment, validateFrontendDeployment } from "./deployment-config.mjs";

// Deployment commands intentionally use platform bindings, not a developer .env.
// A .env would still be read by the application/Prisma; refuse it in the runbook.
try {
  if ([".", "frontend"].some((directory) => readdirSync(directory).some((name) => name.startsWith(".env") && !name.endsWith(".example"))))
    throw new Error("Deployment commands require platform bindings and no local .env files.");
  const target = process.argv[2];
  if (target === "frontend") validateFrontendDeployment(process.env);
  else if (target === "api") validateApiDeployment(process.env);
  else throw new Error("Choose api or frontend deployment validation.");
  console.log(`Deployment ${target} bindings validated (values hidden).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid deployment configuration (values hidden).");
  process.exitCode = 1;
}
