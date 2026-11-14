import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import pg from "pg";
import { requireLocalTestDatabase } from "../dist/config.js";

const root = process.cwd();
const cleanUrl = requireLocalTestDatabase(process.env.CLEAN_DATABASE_URL);
const upgradeUrl = requireLocalTestDatabase(process.env.UPGRADE_DATABASE_URL);
const urls = [cleanUrl, upgradeUrl, process.env.TEST_DATABASE_URL]
  .filter(Boolean)
  .map((value) => {
    const url = new URL(value);
    assert.ok(
      !url.searchParams.has("schema") ||
        url.searchParams.get("schema") === "public",
      "Only the public test schema is supported",
    );
    return `${url.hostname}:${url.port || 5432}${url.pathname}`;
  });
assert.equal(
  new Set(urls).size,
  urls.length,
  "Clean/upgrade/main test databases must be different",
);
const clean = new pg.Client({
  connectionString: cleanUrl,
  connectionTimeoutMillis: 5000,
});
const upgrade = new pg.Client({
  connectionString: upgradeUrl,
  connectionTimeoutMillis: 5000,
});
const directory = mkdtempSync(join(tmpdir(), "fixit-hybrid-migrations-"));
const initialName = "20261109200000_init_database_schema";
const hybridName = "20261114130000_hybrid_mvp";
const reviewName = "20261114150000_review_snapshot_alignment";
const initialPath = join(
  root,
  "prisma/migrations",
  initialName,
  "migration.sql",
);
const hybridSQL = readFileSync(
  "prisma/migrations/20261114130000_hybrid_mvp/migration.sql",
  "utf8",
);
const initialHash = createHash("sha256")
  .update(readFileSync(initialPath))
  .digest("hex");
const cents = (value) => {
  const n = BigInt(value);
  return `${n / 100n}.${(n % 100n).toString().padStart(2, "0")}`;
};
function run(args, databaseUrl, label) {
  try {
    const output = execFileSync(process.execPath, args, {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(`PASS ${label}`);
    return output;
  } catch (error) {
    const safe = String(error.stderr ?? "").replace(
      /postgres(?:ql)?:\/\/[^\s]+/g,
      "[REDACTED_DATABASE_URL]",
    );
    throw new Error(`${label} failed: ${safe}`);
  }
}
const cli = join(root, "node_modules/prisma/build/index.js");
const deploy = (url, label, config) =>
  run(
    [cli, "migrate", "deploy", ...(config ? ["--config", config] : [])],
    url,
    label,
  );
async function empty(client) {
  assert.equal(
    (
      await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public'",
      )
    ).rows.length,
    0,
    "Migration verification requires newly created EMPTY dedicated *_test databases; it never resets or deletes existing data",
  );
}
async function snapshot(client) {
  const values = [];
  for (const table of [
    "users",
    "master_profiles",
    "services",
    "orders",
    "order_responses",
  ]) {
    values.push(
      (
        await client.query(
          `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`,
        )
      ).rows,
    );
  }
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

try {
  await clean.connect();
  await upgrade.connect();
  await empty(clean);
  await empty(upgrade);
  deploy(cleanUrl, "fresh database applies all three migrations");
  const tables = (
    await clean.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY tablename",
    )
  ).rows.map((r) => r.tablename);
  assert.deepEqual(tables, [
    "master_profiles",
    "order_responses",
    "orders",
    "services",
    "users",
  ]);
  assert.match(
    deploy(cleanUrl, "fresh database repeat deploy"),
    /No pending migrations/,
  );
  run([cli, "db", "seed"], cleanUrl, "fresh hybrid seed");
  const first = await snapshot(clean);
  run([cli, "db", "seed"], cleanUrl, "repeat hybrid seed");
  assert.equal(
    await snapshot(clean),
    first,
    "Repeated seed changed persisted data/history",
  );

  const initialDir = join(directory, "migrations", initialName);
  mkdirSync(initialDir, { recursive: true });
  copyFileSync(initialPath, join(initialDir, "migration.sql"));
  copyFileSync(
    "prisma/migrations/migration_lock.toml",
    join(directory, "migrations/migration_lock.toml"),
  );
  const config = join(directory, "prisma.config.mjs");
  writeFileSync(
    config,
    `export default ${JSON.stringify({ schema: resolve("prisma/schema.prisma"), migrations: { path: join(directory, "migrations") } }).replace(/}$/, ",datasource:{url:process.env.DATABASE_URL}}")};\n`,
  );
  deploy(
    upgradeUrl,
    "legacy database applies untouched initial migration",
    config,
  );
  const clientId = randomUUID(),
    masterId = randomUUID(),
    otherMasterId = randomUUID(),
    profileId = randomUUID(),
    otherProfileId = randomUUID(),
    serviceId = randomUUID(),
    tinyServiceId = randomUUID();
  const salt = randomBytes(16),
    hash = scryptSync(randomBytes(32), salt, 64);
  const passwordHash = `scrypt$16384$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
  for (const [id, role] of [
    [clientId, "CLIENT"],
    [masterId, "MASTER"],
    [otherMasterId, "MASTER"],
  ]) {
    await upgrade.query(
      "INSERT INTO users(id,email,password_hash,name,role) VALUES($1,$2,$3,'Synthetic legacy',$4::user_role)",
      [id, `${id}@legacy.fixit.test`, passwordHash, role],
    );
  }
  await upgrade.query(
    "INSERT INTO master_profiles(id,user_id,city,bio) VALUES($1,$2,'Legacy Test City','Preserved legacy description'),($3,$4,'Other Test City',NULL)",
    [profileId, masterId, otherProfileId, otherMasterId],
  );
  await upgrade.query(
    "INSERT INTO services(id,master_profile_id,title,category,description,price_cents) VALUES($1,$2,'Legacy title','PLUMBING','Legacy service',2147483647),($3,$2,'One cent','PLUMBING','Tiny price',1)",
    [serviceId, profileId, tinyServiceId],
  );
  const prices = [1, 25000, 0, 2147483647, 40000];
  const statuses = [
    "PENDING",
    "ACCEPTED",
    "IN_PROGRESS",
    "COMPLETED",
    "CANCELLED",
  ];
  for (let i = 0; i < statuses.length; i++)
    await upgrade.query(
      "INSERT INTO orders(id,client_id,service_id,description,price_at_order_cents,status,created_at) VALUES($1,$2,$3,$4,$5,$6::order_status,'2025-01-02T03:04:05.123Z')",
      [
        randomUUID(),
        clientId,
        serviceId,
        `Synthetic legacy ${i}`,
        prices[i],
        statuses[i],
      ],
    );
  const before = (
    await upgrade.query(
      "SELECT id,client_id,service_id,description,price_at_order_cents,status::text,created_at FROM orders ORDER BY id",
    )
  ).rows;
  // Unsupported legacy text is refused, never silently replaced by OTHER.
  await upgrade.query(
    "UPDATE services SET category='UNMAPPED_LEGACY' WHERE id=$1",
    [tinyServiceId],
  );
  await assert.rejects(
    upgrade.query(hybridSQL),
    /recategorise unsupported legacy/,
  );
  await upgrade.query("ROLLBACK");
  assert.equal(
    (await upgrade.query("SELECT count(*)::int AS n FROM orders")).rows[0].n,
    5,
  );
  assert.equal(
    (
      await upgrade.query(
        "SELECT count(*)::int AS n FROM pg_type WHERE typname='order_type'",
      )
    ).rows[0].n,
    0,
  );
  await upgrade.query("UPDATE services SET category='PLUMBING' WHERE id=$1", [
    tinyServiceId,
  ]);
  console.log(
    "PASS unsupported category refuses migration atomically; no rows/prices dropped",
  );
  const observedAfter = Date.now() - 1000;
  const hybridDir = join(directory, "migrations", hybridName);
  mkdirSync(hybridDir);
  copyFileSync(join(root, "prisma/migrations", hybridName, "migration.sql"), join(hybridDir, "migration.sql"));
  deploy(upgradeUrl, "upgrade legacy orders with the unchanged Hybrid migration", config);
  // Model a database that already ran Hybrid: the review migration must only
  // install guards/optional fields, never rewrite historical snapshots/events.
  const beforeReview = (await upgrade.query("SELECT to_jsonb(o) AS value FROM orders o ORDER BY id")).rows;
  deploy(upgradeUrl, "apply review follow-up to the existing Hybrid database");
  const afterReview = (await upgrade.query("SELECT to_jsonb(o) - 'budget' AS value FROM orders o ORDER BY id")).rows;
  assert.deepEqual(afterReview, beforeReview, "Review migration rewrote existing order data/history");
  const after = (await upgrade.query("SELECT * FROM orders ORDER BY id")).rows;
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    const a = after[i],
      b = before[i];
    for (const key of [
      "id",
      "client_id",
      "service_id",
      "description",
      "status",
    ])
      assert.equal(a[key], b[key]);
    assert.equal(a.created_at.toISOString(), b.created_at.toISOString());
    assert.equal(a.price_at_order, cents(b.price_at_order_cents));
    assert.equal(a.type, "STANDARD");
    assert.equal(a.master_profile_id, profileId);
    assert.equal(a.title, "Legacy title");
    assert.equal(a.city, "Legacy Test City");
    assert.equal(a.category, "PLUMBING");
    assert.equal(a.budget, null);
    assert.equal(a.status_history.length, 1);
    assert.equal(a.status_history[0].source, "legacy_migration");
    assert.equal(a.status_history[0].status, b.status);
    assert.ok(Date.parse(a.status_history[0].at) >= observedAfter, "Legacy status must be observed at migration time, not invented at order creation");
    assert.equal(Date.parse(a.status_history[0].legacyCreatedAt), b.created_at.getTime());
  }
  const services = (
    await upgrade.query("SELECT id,price_estimate FROM services ORDER BY id")
  ).rows;
  assert.equal(services.find((s) => s.id === serviceId).price_estimate, "21474836.47");
  assert.equal(services.find((s) => s.id === tinyServiceId).price_estimate, "0.01");
  const profiles = (
    await upgrade.query("SELECT id,description,category FROM master_profiles")
  ).rows;
  assert.equal(
    profiles.find((p) => p.id === profileId).description,
    "Preserved legacy description",
  );
  assert.equal(profiles.find((p) => p.id === otherProfileId).description, null);
  assert.equal(profiles.find((p) => p.id === otherProfileId).category, "OTHER");
  for (const name of [initialName, hybridName, reviewName]) {
    const migration = (await upgrade.query("SELECT checksum FROM _prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL", [name])).rows;
    assert.equal(migration.length, 1);
    const hash = name === initialName ? initialHash : createHash("sha256").update(readFileSync(join(root, "prisma/migrations", name, "migration.sql"))).digest("hex");
    assert.equal(migration[0].checksum, hash);
  }
  const immutable = await snapshot(upgrade);
  for (const [field, value] of [["title", "Changed"], ["city", "Changed"], ["category", "OTHER"], ["description", "Changed"], ["budget", "1.00"]]) {
    await upgrade.query("BEGIN");
    try {
      await upgrade.query("UPDATE services SET title='Must roll back' WHERE id=$1", [serviceId]);
      await assert.rejects(upgrade.query(`UPDATE orders SET ${field}=$1 WHERE id=$2`, [value, before[0].id]), (error) => error.code === "23514" && error.message === "Order content snapshots are immutable");
    } finally {
      await upgrade.query("ROLLBACK");
    }
    assert.equal(await snapshot(upgrade), immutable, `Rejected ${field} edit or earlier writes changed legacy data`);
  }
  console.log("PASS review migration preserves existing Hybrid rows/history; each legacy snapshot field is protected and earlier writes roll back");
  const state = await snapshot(upgrade);
  assert.match(
    deploy(upgradeUrl, "legacy upgrade repeat deploy"),
    /No pending migrations/,
  );
  assert.equal(await snapshot(upgrade), state);
  console.log(
    "PASS 5 old orders/all old statuses, IDs, timestamps, descriptions and exact prices (0/1/max int cents) preserved",
  );
  console.log(
    "PASS all three migration checksums match files; legacy nullable biography preserved",
  );
  console.log(
    "Migration verification complete. Dedicated databases retained for inspection; no reset/drop performed.",
  );
} finally {
  await clean.end();
  await upgrade.end();
  rmSync(directory, { recursive: true, force: true });
}
