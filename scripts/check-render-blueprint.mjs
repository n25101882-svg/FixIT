import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** render.yaml uses JSON syntax, a YAML subset: no parser dependency needed.
 * This checks project safety invariants, not Render's remote/live schema. */
export function validateBlueprint(blueprint) {
  assert.deepEqual(Object.keys(blueprint).sort(), ["databases", "services"]);
  assert.equal(blueprint.services.length, 1, "Expected one single-origin Node service.");
  assert.equal(blueprint.databases.length, 1, "Expected one new database only.");
  const api = blueprint.services.find((service) => service.runtime === "node");
  const db = blueprint.databases[0];
  assert.ok(api, "Node runtime is required.");
  assert.equal(api.plan, "free"); assert.equal(db.plan, "free");
  assert.equal(typeof db.postgresMajorVersion, "string", "Render Blueprint requires postgresMajorVersion to be a string.");
  assert.equal(db.postgresMajorVersion, "18"); assert.deepEqual(db.ipAllowList, []);
  assert.equal(api.region, db.region); assert.equal(api.healthCheckPath, "/health/ready");
  assert.equal(api.buildCommand, "npm ci --include=dev && npm run deploy:build:api");
  assert.equal(api.startCommand, "npm run deploy:start");
  const bindings = (service) => {
    const result = Object.fromEntries(service.envVars.map((item) => [item.key, item]));
    assert.equal(Object.keys(result).length, service.envVars.length, "Duplicate bindings.");
    return result;
  };
  const apiEnv = bindings(api);
  assert.equal(apiEnv.HOST.value, "0.0.0.0"); assert.equal(apiEnv.NODE_ENV.value, "production");
  assert.equal(apiEnv.TRUST_PROXY_HOPS.value, "1"); assert.deepEqual(apiEnv.JWT_SECRET, { key: "JWT_SECRET", generateValue: true });
  assert.equal(apiEnv.JWT_TTL_SECONDS.value, "900");
  assert.deepEqual(apiEnv.CORS_ORIGINS, { key: "CORS_ORIGINS", sync: false });
  assert.deepEqual(apiEnv.VITE_API_URL, { key: "VITE_API_URL", value: "/api/v1" });
  assert.equal(apiEnv.SERVE_FRONTEND.value, "1");
  assert.deepEqual(apiEnv.DATABASE_URL.fromDatabase, { name: db.name, property: "connectionString" });
  assert.equal(apiEnv.NODE_VERSION.value, "24.22.1");
  assert.deepEqual(Object.keys(apiEnv).sort(), ["NODE_VERSION", "NODE_ENV", "HOST", "TRUST_PROXY_HOPS", "JWT_TTL_SECONDS", "JWT_SECRET", "CORS_ORIGINS", "DATABASE_URL", "VITE_API_URL", "SERVE_FRONTEND"].sort());
  for (const service of [api]) {
    assert.equal(service.repo, "https://github.com/n25101882-svg/FixIT");
    assert.equal(service.branch, "develop"); assert.equal(service.autoDeployTrigger, "off");
    assert.equal(service.preDeployCommand, undefined, "No paid pre-deploy feature.");
    assert.equal(service.dockerCommand, undefined);
    assert.equal(service.disk, undefined);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    validateBlueprint(JSON.parse(readFileSync("render.yaml", "utf8")));
    console.log("Render blueprint local safety checks passed; live Render validation/deployment NOT performed.");
  } catch {
    console.error("Render blueprint failed local safety checks. No cloud action was performed.");
    process.exitCode = 1;
  }
}
