import { isIP } from "node:net";

/** Deployment-only checks. Values never appear in errors or success logs. */
function fail(message) { throw new Error(message); }
function publicHttps(value, label, api = false) {
  let url;
  try { url = new URL(value); } catch { fail(`${label} must be an explicit public HTTPS URL.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !url.hostname.includes(".") || isIP(url.hostname) || url.hostname.startsWith("[")
    || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".internal")
    || (api ? url.pathname !== "/api/v1" : value !== url.origin))
    fail(`${label} must be an explicit public HTTPS ${api ? "API URL ending in /api/v1" : "origin without a path"}.`);
}
function secureTransport(env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0" || env.npm_config_strict_ssl === "false" || env.NPM_CONFIG_STRICT_SSL === "false"
    || env.PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING)
    fail("TLS and Prisma checksum verification must remain enabled.");
}
export function validateFrontendDeployment(env) {
  secureTransport(env);
  publicHttps(env.VITE_API_URL, "VITE_API_URL", true);
  if (Object.keys(env).some((key) => key.startsWith("VITE_") && key !== "VITE_API_URL"))
    fail("Only the public VITE_API_URL is allowed in frontend deployment bindings.");
}
export function validateApiDeployment(env) {
  secureTransport(env);
  if (env.NODE_ENV !== "production" || env.HOST !== "0.0.0.0" || env.TRUST_PROXY_HOPS !== "1")
    fail("API deployment requires NODE_ENV=production, HOST=0.0.0.0 and TRUST_PROXY_HOPS=1.");
  if (!env.PORT || !/^\d+$/.test(env.PORT) || Number(env.PORT) < 1 || Number(env.PORT) > 65535)
    fail("API deployment requires a valid platform PORT.");
  if (!env.JWT_SECRET || Buffer.byteLength(env.JWT_SECRET) < 32 || /CHANGE_ME|REPLACE_ME|EXAMPLE_SECRET/i.test(env.JWT_SECRET))
    fail("JWT_SECRET must be a private generated value of at least 32 bytes.");
  if (!env.CORS_ORIGINS) fail("Set the actual frontend CORS_ORIGINS explicitly.");
  const ttl = Number(env.JWT_TTL_SECONDS ?? 900);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) fail("JWT_TTL_SECONDS must be between 60 and 86400.");
  for (const origin of env.CORS_ORIGINS.split(",")) publicHttps(origin.trim(), "CORS_ORIGINS");
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { fail("DATABASE_URL must be a private PostgreSQL binding."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.pathname.length < 2
    || /CHANGE_ME|REPLACE_ME/.test(decodeURIComponent(url.password))) fail("DATABASE_URL must be a private PostgreSQL binding.");
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => !["schema", "sslmode"].includes(key)) || new Set(keys).size !== keys.length
    || (url.searchParams.has("schema") && url.searchParams.get("schema") !== "public"))
    fail("DATABASE_URL contains unsupported routing or TLS overrides.");
  if (["fixit_dev", "fixit_test", "fixit_shadow"].includes(decodeURIComponent(url.pathname.slice(1))))
    fail("Reserved existing databases must not be deployment or rehearsal targets.");
  const mode = url.searchParams.get("sslmode");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const internalRender = /^dpg-[a-z0-9-]+$/.test(url.hostname);
  if ((loopback && !/^[a-z][a-z0-9_]*_test$/.test(decodeURIComponent(url.pathname.slice(1))))
    || (mode !== null && mode !== "verify-full") || (!loopback && !internalRender && mode !== "verify-full"))
    fail("Use the Render internal DB binding, verified TLS for external DBs, or a loopback *_test rehearsal DB.");
  if (["TEST_DATABASE_URL", "SHADOW_DATABASE_URL", "CLEAN_DATABASE_URL", "UPGRADE_DATABASE_URL"].some((key) => env[key]))
    fail("Test/shadow database bindings must not be present in the deployed API.");
}
