# Render deployment and rollback — FixIT MVP

This is a runbook and configuration proposal, **not a deployed environment**. Creating/applying a Blueprint starts resource creation and can start the first deployment even with autodeploy off. Obtain separate approval first. Do not create release/v1.0.0 until the FIX-17 decision and QA gates are complete.

## Topology and reproducible commands

[render.yaml](../render.yaml) defines a Node API, Vite static site and PostgreSQL 18, all targeting free/default-free hosting. It uses JSON syntax, which is valid YAML, to support dependency-free local validation. No Docker, paid pre-deploy hook, disk, autoscaling, preview environment or cloud credentials are configured. PostgreSQL external access defaults to denied (`ipAllowList: []`). API and DB share a region.

| Component | Build | Start / output |
| --- | --- | --- |
| API | npm ci --include=dev && npm run deploy:build:api | npm run deploy:start |
| React static site | npm ci --include=dev && npm run deploy:build:frontend | frontend/dist |
| PostgreSQL | Provider-managed PostgreSQL 18 | New fixit database, never existing fixit_dev/fixit_test/fixit_shadow |

Node is pinned to 24.22.1 in .nvmrc and Blueprint; npm must satisfy >=11 <12. package-lock.json and Prisma 7.10.1 are unchanged. Backend build generates Prisma Client before tsc. Free-compatible startup validates bindings, runs **migrate deploy**, then starts compiled dist/server.js. A failed guard/migration prevents API startup. Every cold start may repeat the idempotent migration check; no seed/reset/db push/migrate dev runs on Render. There is no shadow DB in this deployment.

Dev dependencies deliberately remain installed because the existing Prisma CLI is a dev dependency and migrations run before startup. This also retains the known Jest dev advisories in the installed tree: production-only audit 0 does **not** mean the entire hosted filesystem is advisory-free. Risk review is a release gate. Do not prune dev dependencies without redesigning the migration step; do not silently enable a paid hook.

## Environment matrix

| Binding | API | Static build | Rule |
| --- | --- | --- | --- |
| NODE_VERSION | 24.22.1 | 24.22.1 | Blueprint pin |
| NODE_ENV | production | Vite build uses production mode | Not a JWT mechanism change |
| HOST | 0.0.0.0 | — | API listens on platform interface |
| PORT | Render-provided | — | No hardcoded production port; validated 1–65535 |
| TRUST_PROXY_HOPS | 1 | — | Exactly one trusted ingress; local default 0 |
| DATABASE_URL | fromDatabase internal connectionString | **absent** | Secret, new PG18 only |
| JWT_SECRET | generateValue: true | **absent** | Private persistent generated binding, at least 32 bytes |
| JWT_TTL_SECONDS | 900 | — | Existing 60–86400 range |
| CORS_ORIGINS | sync:false, actual public frontend HTTPS origin(s) | — | Exact origins, no wildcard/path/trailing slash |
| VITE_API_URL | — | sync:false, actual public API HTTPS URL ending /api/v1 | Public build-time value, rebuild after a change |
| TEST/SHADOW/CLEAN/UPGRADE_DATABASE_URL | **absent** | **absent** | Never deployed or used for production tests |

Only VITE_API_URL may be supplied as a VITE_* deployment variable. Do not put database credentials/JWT secrets into any frontend binding. Deploy commands reject local .env files in the repository/frontend; use platform bindings, not a copied developer configuration. Local .env.example remains for local work, not production defaults.

API deployment accepts the provider's private `dpg-...` internal hostname, an external DB with sslmode=verify-full, or a dedicated loopback *_test only for local rehearsal. It rejects reserved database names, URL routing overrides/duplicate query keys, insecure TLS flags and non-public schemas. Internal private-network routing is not evidence of verified public TLS; external verified TLS must stay enabled. Never set NODE_TLS_REJECT_UNAUTHORIZED=0, npm strict-ssl=false, or PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING (even the string 0). Do not print binding values.

## Before any real cloud action

1. Review/merge the preparation PR manually. Record the exact approved commit, build/start commands, Node version and migration checksums; coordinate deploys so develop does not move unnoticed. Autodeploy is off for both services. No release branch/tag is created by this task.
2. Resolve the FIX-17 decision and complete local QA/security risk review using [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md). A decision to accept the UX limitation must be explicit; no acceptance is assumed here.
3. In Render, **validate/preview only**: confirm current support for PostgreSQL 18, free API/DB plans, region, all field names and account billing/quotas. Check free DB expiry, storage, sleep/cold-start, backup/PITR availability. Free plans are suitable for a controlled MVP demonstration only if their limits are accepted. If PG18/free is unavailable, stop: do not select a paid plan or downgrade PostgreSQL silently.
4. Confirm resource names identify new resources. Do not adopt/delete/overwrite an existing database. Verify the preview has no paid resource or add-on and that spending controls meet the owner's constraints.
5. Obtain **separate approval for initial deployment/resource creation** before Apply/Create. This runbook does not grant that approval.

The public Render docs/schema were blocked by this Cloud environment's proxy (CONNECT HTTP 403). Local `npm run deploy:validate` checks project safety invariants only; it is not Render's live schema validation. Useful provider references for the operator: [Blueprint specification](https://render.com/docs/blueprint-spec), [free limits](https://render.com/docs/free), [Node version](https://render.com/docs/node-version), [PostgreSQL](https://render.com/docs/postgresql-creating-connecting), [deploys](https://render.com/docs/deploys). Availability and current quotas remain a manual gate.

## Approved deployment sequence

After approval only:

1. In Blueprint preview, choose unique API/static names and fill the two sync:false values with the actual intended domains. CORS_ORIGINS is the frontend origin; VITE_API_URL is the API URL plus /api/v1. If Render assigns a different hostname, correct both bindings and redeploy the affected component. Format validation cannot prove DNS/service ownership.
2. Apply the reviewed Blueprint. Confirm the DB engine is 18, external allowlist is empty, DATABASE_URL resolves to this new internal DB, JWT_SECRET is privately generated, and no test/shadow bindings or local .env files exist on the services.
3. Deploy the API's approved commit. Migration startup must finish with all three existing migrations applied/up to date before the listening message. Do not publish secret settings or connection strings from logs. Check /health (liveness) and /health/ready (SELECT 1/readiness). Readiness proves connectivity, not the complete business scenario; ST3–ST5 are still required.
4. Confirm Render's actual ingress topology safely matches one-hop trust and that arbitrary client-supplied forwarding headers cannot choose the rate-limit identity. Local tests verify Express behaviour, not Render's edge configuration. Never change trust proxy to true to suppress a warning.
5. Build/deploy the static site with the actual VITE_API_URL. The SPA rewrite `/* → /index.html` must preserve real assets and permit direct /catalog, /login, /orders/UUID and /master/orders/UUID URLs. Authenticated direct URLs still require login after F5 (FIX-17).
6. Run ST1–ST5 with synthetic accounts/orders, record the actual deployed commit for **both** services, status codes, timezone and evidence. Only then consider release approval. Do not seed, run npm test or invoke migration-verification scripts against Render data.

There is no fixed live URL or created resource ID to report in this PR. CORS changes apply on API restart; VITE_API_URL changes require a frontend rebuild. Changing JWT_SECRET invalidates existing tokens: retain it on routine rollback and rotate only under an explicit incident/change decision.

## Windows 11 local verification

Use Node 24/npm 11, Git and PostgreSQL 18 tools. Create only a **new dedicated** loopback fixit_release_test via your local administrator/limited owner. Keep existing fixit_dev/fixit_test/fixit_shadow untouched. Set private DATABASE_URL and TEST_DATABASE_URL to the same new *_test; configure a private random JWT_SECRET. Shadow is unnecessary for migrate deploy. Do not automatically overwrite any existing role/password.

```powershell
git fetch origin
git switch chore/release-preparation
if (!(Test-Path .env)) { Copy-Item .env.example .env }
# Configure the private test bindings before running verification.
npm ci --include=dev
npm run release:verify
```

Install Chromium first if missing: npm exec playwright install chromium. On Windows do not set the Cloud PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. release:verify checks loopback test bindings before migration/test writes and refuses reserved/mismatched endpoints. It runs generation, schema/ER checks, deploy/status/connection, typecheck, all backend/frontend/coverage/browser tests and local Blueprint checks. No reset/drop is used. Existing synthetic history can remain in the dedicated test DB.

For fresh/upgrade migration verification, create two **additional new empty** *_test DBs, distinct from main and each other; privately set CLEAN_DATABASE_URL and UPGRADE_DATABASE_URL, then run npm run test:migrations. The verifier refuses nonempty DBs; repeat with another new pair, never clear an old DB.

## Codex Cloud verification

On this prepared machine, source /workspace/.fixit-dev/release-env.sh supplies private bindings for fixit_release_test and dedicated clean/upgrade DBs. The helper is not in Git; another environment must provide its own bindings. Run npm ci --include=dev and npm run release:verify. Run test:migrations once on the explicitly prepared empty pair. No production/home database or reserved fixit_test/fixit_shadow is a test target.

A local production-command rehearsal was executed against fixit_release_test: platform HOST/PORT, guard → repeat migrate deploy → npm start, health 200, readiness 200, allowed/disallowed CORS 200/403, protected route 401. Its public-origin/API values were synthetic format examples, not deployed URLs. It created no Render resource. Render-side rewrite, edge topology, DB provisioning and live ST1–ST5 remain NOT RUN.

## Backup before a later deployment

For a real environment with data, require an authorised backup and restore drill first. Do not assume a free plan supplies snapshots/PITR. A free API may not provide shell/one-off jobs; this configuration does not depend on them.

An approved operator can use PostgreSQL 18 pg_dump/pg_restore on Windows/Cloud **only if the database/network policy permits it**. Prefer the provider's approved backup facility. If external access is required, separately approve a narrow temporary operator-IP /32 allowlist, verified TLS and removal after the backup. Never open 0.0.0.0/0, tunnel around a blocked network, or commit a connection string. A Blueprint sync must not silently leave a temporary exception open.

Supply libpq PGHOST/PGPORT/PGUSER/PGDATABASE/PGSSLMODE=verify-full and a private ACL-restricted PGPASSFILE from a secret manager, not command-line credentials or shell history. The examples below assume those private bindings are already supplied; print none of them.

```powershell
# Store outside Git in approved encrypted backup storage.
if (Test-Path $env:FIXIT_BACKUP_PATH) { throw 'Choose a new backup filename' }
pg_dump --no-password --format=custom --no-owner --no-acl --file $env:FIXIT_BACKUP_PATH
if ($LASTEXITCODE -ne 0) { throw 'Backup failed; deployment blocked' }
Get-FileHash -Algorithm SHA256 $env:FIXIT_BACKUP_PATH
```

```bash
test ! -e "$FIXIT_BACKUP_PATH" &&
pg_dump --no-password --format=custom --no-owner --no-acl --file "$FIXIT_BACKUP_PATH" &&
sha256sum "$FIXIT_BACKUP_PATH"
```

A checksum checks the file, not restorability. Perform the restore drill into an explicitly authorised **new empty** database with newly supplied libpq bindings: pg_restore --exit-on-error --no-owner --no-acl --dbname chosen_new_empty_database backup_file. Never use --clean/reset or restore over an existing database. Verify schema/migration checksums, row counts and synthetic lifecycle before approving recovery. Do not create a paid recovery database without approval. Backups/pgpass files are ignored by Git and must stay in protected storage, not a report.

## Rollback

Record a last-known-good **deployed** API/static revision and matching settings before subsequent deploys. There is no known previous Render deployment in this task. Base 2af15f5 predates deploy:* scripts and is not a drop-in rollback target with the new start command.

1. If the new deployment is unhealthy, stop further deploys and operator mutations; preserve logs/data without secrets. Use the provider's rollback/manual-deploy mechanism for the previous approved compatible artifact, with its matching build/start commands and public URL bindings. Keep the private DATABASE_URL/JWT_SECRET stable unless an incident decision says otherwise.
2. Roll back both API/static when required; the frontend's API URL is embedded at build time. Recheck readiness, CORS, direct SPA URLs and ST1–ST5. Record the actual SHA of both components and the reason.
3. **App rollback does not roll back PostgreSQL.** This PR changes no schema or migration; future schema changes require an explicit compatibility assessment. Do not edit applied SQL, run a down/reset/db push, or delete data to make an old binary start. Prefer a forward fix.
4. If data recovery is required, restore the approved backup into a separately approved new empty DB, verify it, then explicitly approve rebinding the API. Retain the original DB for inspection. A restore is a separate operational action.
5. On the first deployment, if no compatible last-good artifact exists, suspend public traffic/service or fix forward after approval; do not invent a successful rollback. Preserve the DB, acknowledging free-plan expiry limits. Fill the result template with the actual incident outcome.

No deploy, backup, restore, paid resource, release/v1.0.0 or merge was executed by this preparation.
