# Render deployment and rollback — single-origin FixIT

This is a reviewed configuration proposal, **not a deployed environment**. Do not Apply Blueprint, create resources, enable auto-sync/autodeploy or deploy without separate owner approval. Applying a Blueprint can start the first deploy even with automatic deployment disabled. No release/v1.0.0 branch/tag is created here.

The current FIX-17 decision is Access JWT + rotating PostgreSQL refresh sessions. [Architecture/security/test evidence](FIX_17_REFRESH_SESSIONS.md), [release gates and ST1–ST5](RELEASE_CHECKLIST.md), [future Windows QA](WINDOWS_SESSION_QA.md). Earlier practical reports describe earlier architecture and are not rewritten.

## One origin, two resources

[render.yaml](../render.yaml) defines **one free Node Web Service `fixit-web`** serving Express `/api/v1`, health endpoints and compiled React, plus **one separate free PostgreSQL 18**. There is no static-site resource or third-party refresh cookie. JSON is used as a valid YAML subset for dependency-free validation. PostgreSQL `postgresMajorVersion` is the string `"18"`. API and DB share a region, external DB access is denied with `ipAllowList: []`.

No paid plan, disk, Docker, autoscaling, preview environment, pre-deploy hook or cloud credential is configured. Current free-plan availability/expiry/quotas must be confirmed in Render before any approved creation; stop if PG18/free is unavailable, without silently choosing a paid plan or downgrading.

| Resource | Build | Start / output |
| --- | --- | --- |
| Node Web Service | `npm ci --include=dev && npm run deploy:build:api` | `npm run deploy:start` |
| Same Node build | Prisma Generate → TypeScript backend → guarded Vite production build | `dist/server.js` serves `frontend/dist` and API |
| PostgreSQL | Provider-managed 18 | A new `fixit` database, never an existing developer/test database |

Node is pinned to 24.22.1, npm >=11 <12, Prisma 7.10.1 and the lockfile are retained. Startup validates bindings, runs **migrate deploy**, then starts the compiled server, which checks DB connectivity before listen. Four migrations must be applied. Repeated startup performs an idempotent deploy check; it never runs seed/reset/db push/migrate dev. No shadow DB is required.

Dev dependencies remain installed because Prisma CLI runs at startup. The current production-only audit has 0 findings, but the installed full tree retains 19 inherited dev findings (3 low, 16 moderate). Do not describe the artifact as vulnerability-free, prune the migration CLI silently, or enable a paid hook to hide this issue.

## Environment bindings

| Binding | Value / rule |
| --- | --- |
| NODE_VERSION | 24.22.1 |
| NODE_ENV | production |
| HOST | 0.0.0.0 |
| PORT | Render-provided, validated 1–65535, not hardcoded in Blueprint |
| TRUST_PROXY_HOPS | 1, one trusted Render ingress; local/direct default 0 |
| SERVE_FRONTEND | 1; startup refuses missing built index.html |
| DATABASE_URL | Private fromDatabase connectionString for this new PG18 |
| JWT_SECRET | generateValue:true, private persistent secret, at least 32 bytes |
| JWT_TTL_SECONDS | 900, required for production |
| CORS_ORIGINS | sync:false; the exact HTTPS origin of this same Node service, no path/trailing slash/wildcard |
| VITE_API_URL | `/api/v1`, public build-time relative path; no separate API origin |
| TEST/SHADOW/CLEAN/UPGRADE_DATABASE_URL | Absent; never deployed |

Only VITE_API_URL may be supplied as a VITE_* deployment variable. Non-VITE server bindings are not exposed by the Vite bundle. Do not put credentials/JWT values in frontend config, Git, screenshots or logs. Deployment commands reject repository/frontend local .env files; use platform bindings, not copied developer secrets.

The DB guard permits Render's private `dpg-...` hostname, an external DB only with sslmode=verify-full, or a dedicated loopback *_test for local rehearsal. Reserved existing DB names, routing overrides, insecure TLS switches, non-public schemas and test/shadow deployment bindings are rejected. Private-network routing is not proof of verified external TLS. Never disable TLS or Prisma checksum verification.

## Cookie, CSRF and ingress policy

Production refresh uses `__Host-fixit_refresh; Secure; HttpOnly; SameSite=Lax; Path=/`, no Domain, with a 7-day absolute / 24-hour idle server lifetime. Refresh/logout rotate/revoke PostgreSQL state; access JWT is memory-only with a 15-minute TTL. Already-issued stateless access JWTs remain valid until expiry after Logout. SameSite=None and separate-origin/third-party cookies are not used.

Login/register/refresh/logout require exact Origin, X-FixIT-CSRF:1, JSON and non-cross-site Fetch Metadata. CORS credentials are auth-only, exact-origin. Bearer business calls omit cookies. Render ingress must supply trusted HTTPS information correctly: local tests verify Express one-hop behaviour, **not the real Render edge**. Never set blanket trust proxy=true.

Local HTTP development has a different cookie name and is restricted to actual loopback Host plus socket. Production Secure cannot be turned off. The real Chromium rehearsal used the production Secure cookie on browser-trusted localhost HTTP; it does not establish real Render certificate/TLS behaviour.

## Static files and health

SERVE_FRONTEND=1 serves only the built frontend directory. API/health namespaces, including encoded forms, return JSON 404 for unknown routes and are never rewritten to HTML. Dotfiles, absent assets and extension paths do not get the SPA. HTML navigation to React paths receives non-cached index.html; Vite assets get immutable caching. Security headers include nosniff, DENY framing and a referrer policy.

`/health` is liveness, `/health/ready` executes a DB check and returns 503 on failure. Readiness alone does not prove business workflows or refresh security. Startup guards/migration errors prevent a healthy deployment. Ordinary `npm start` runs the compiled app; the Render startCommand additionally enforces deployment bindings and migrations.

## Before any cloud action

1. Review this PR; manually merge only after approval. Record the exact approved SHA/settings and four migration checksums. Do not deploy an unreviewed moving develop head.
2. Review FIX-17 residual risks, inherited dev advisories and missing business-POST idempotency. Cloud automated QA is completed; Windows checks are future optional corroboration, not a requirement for creating this PR.
3. Validate/preview the current Blueprint schema, PG18/free availability, quotas, storage, DB expiry/backups/PITR, region and account billing. Verify names refer to new resources, not adoption or overwriting an existing database.
4. Keep **autoDeployTrigger:off**. Separately ensure **Blueprint automatic sync is disabled in the dashboard**. The latter is a provider setting, not an invented YAML key; this task has neither read nor changed account settings. Auto-deploy off does not prevent an initial Apply deployment.
5. Obtain separate approval before Apply/Create/deployment. This document grants none.

On 2026-11-16 the public Render schema request was **BLOCKED by proxy CONNECT HTTP 403**. `npm run deploy:validate` checks local safety invariants, not the provider's live schema. [Blueprint spec](https://render.com/docs/blueprint-spec), [free limits](https://render.com/docs/free), [PostgreSQL](https://render.com/docs/postgresql-creating-connecting), [deploys](https://render.com/docs/deploys). Do not bypass a network block.

## Approved future deployment sequence

After separate approval only:

1. Preview the one-Node/one-PG Blueprint and its $0/free choices. Set CORS_ORIGINS to the intended Node HTTPS origin. Keep VITE_API_URL=/api/v1. If the assigned hostname differs, correct CORS_ORIGINS and restart before auth QA; do not introduce another static origin.
2. Apply only the approved new resources. Confirm PostgreSQL 18, empty external allowlist, new internal DB binding, persistent generated JWT secret, no test bindings and dashboard auto-sync off.
3. Build the approved commit. The guarded build must generate Prisma/backend/frontend. Start must report all four migrations applied/up to date before listening. Do not publish settings/connection strings or Set-Cookie values from logs.
4. Verify HTTPS certificate, /health, /health/ready, assets, direct React URLs, missing API JSON 404 and actual one-hop forwarding provenance. Remote HTTP auth must not create a non-Secure session.
5. In a real browser verify Secure/HttpOnly/host-only/Path/SameSite cookie metadata, same-origin POST Origin/header, successful F5 on CLIENT and MASTER paths, rotation, Logout/F5, no token Web Storage and exact CORS. Redact credential values in evidence.
6. Run ST1–ST5 using synthetic demonstration data and approved read-only DB evidence. Record this **single service's** deployed SHA/settings and actual statuses. No npm tests, migration-verification scripts or seed against Render data.

There is no live URL/resource ID in this PR. Changing JWT_SECRET invalidates both existing JWTs and refresh issuance MACs; keep it persistent across routine deploys. Key rotation requires an explicit incident/change plan. Refresh rows need a future approved retention policy; no cleanup job is silently installed.

## Windows 11 and Codex Cloud verification

For future local QA use [WINDOWS_SESSION_QA.md](WINDOWS_SESSION_QA.md). Use Node24/npm11/PG18 and a **new dedicated** loopback *_test database, private bindings, no production secrets. Keep fixit_dev, existing fixit_test and fixit_shadow untouched. `npm run release:verify` refuses reserved/mismatched test targets before writes. Install Chromium if needed; no Cloud-only executable path on Windows.

The Cloud checks were executed with private `/workspace/.fixit-dev/sessions-env.sh` and the task-created `fixit_sessions_final_test`. The initial probe, clean and upgrade databases were also newly created for this task and retained. No old database was reset/dropped/seeded. Another environment must supply its own bindings; the helper is not committed.

```bash
cd /workspace/FixIT
source /workspace/.fixit-dev/sessions-env.sh
npm ci --include=dev
npm run release:verify
# test:migrations: only after authorising/provisioning a NEW EMPTY clean/upgrade pair.
# The pair used for the completed verification is now nonempty; never clear it.
```

`release:verify` covers local deploy safety, all four migrations/status/DB/ER checks, types, 651 backend, 287 frontend and 43 browser tests plus build/coverage. `test:e2e` always builds production single-origin assets, then runs the previous33 and new10 real Chromium cases. Ports 4100/5174 are Vite regression servers; 4200 is the new one-origin compiled server, with reuseExistingServer=false. No screenshot/trace/video credentials are recorded. See the FIX-17 report for exact results and limits; none is a live Render PASS.

`test:migrations` requires two additional new empty *_test databases distinct from main/each other. It verifies fresh/legacy/three-to-four migration upgrades, repeat deploy/seed, exact old prices/history and business snapshots. It refuses nonempty targets; choose another new pair for a repeat, never reset a used one.

## Backup and rollback

Before a future deployment with existing data, obtain an authorised backup and restore drill. Do not assume free snapshots/PITR or an API shell/one-off job. Prefer the approved provider backup facility. If backup requires external DB access, separately approve a narrow operator-IP /32 allowlist with verified TLS, then remove it. Never open 0.0.0.0/0 or tunnel around network policy.

Supply private libpq bindings and an ACL-restricted PGPASSFILE through approved secret storage, not command-line URLs/history. Keep backups outside Git in approved encrypted storage. A safe backup filename must be new:

```powershell
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

A checksum is not a restore test. Restore only into an explicitly authorised **new empty** database using private bindings and pg_restore --exit-on-error --no-owner --no-acl. Never --clean/reset/overwrite the existing database. Verify migrations/counts and synthetic lifecycle on the restored copy before recovery approval. Do not create a paid recovery resource without approval.

App rollback does **not** roll back PostgreSQL. Retain auth_sessions and all four applied migrations; never edit/replay/down-migrate applied files. Retain the original database as evidence. Routine rollback requires an approved known-good **compatible single-origin/session** artifact and matching settings, with the same persistent secret.

The old PR #11 split-service app is not a drop-in rollback: it lacks refresh/CSRF-aware browser code, server Logout and the new static topology. Old access JWT signatures remain accepted until expiry, but that is not complete legacy-client compatibility. Before first deployment there is no prior deployed compatible session artifact, so an approved fix-forward or temporary suspension is the honest recovery plan. A later decision to remove refresh auth needs a separate revocation/client transition design; it must not silently leave active cookies or claim Logout works.

After any approved rollback/recovery, repeat readiness, direct URLs, cookie recovery/Logout and ST1–ST5 on the actual SHA. Real Render deployment, backup/restore and Windows execution remain **NOT RUN** for this task.
