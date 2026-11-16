# FIX-17 — secure session recovery (PR #12)

Candidate: `fix/fix-17-refresh-sessions`, based on `develop` at `2887f5417c88914d07490f8debd9959c19862628`. Verification date: **2026-11-16, Codex Cloud**. This implements the owner's Access JWT + rotating PostgreSQL refresh-session decision. No Jira changes, merge, release branch, resources or deployment were performed. Previous practical reports remain historical records.

**READY FOR CODE REVIEW.** The automated Cloud checks below passed. Windows manual QA and real Render checks are explicitly NOT RUN; neither is represented as evidence or required from the owner to create this PR.

## Authentication flow

```mermaid
sequenceDiagram
    participant R as React (access JWT in memory)
    participant B as Browser (HttpOnly cookie jar)
    participant A as Express /api/v1
    participant P as PostgreSQL auth_sessions
    R->>A: POST /auth/login (Origin + CSRF header + credentials)
    A->>P: Verify user; store SHA-256 refresh hash
    A-->>B: Set-Cookie: __Host-fixit_refresh; Secure; HttpOnly
    A-->>R: accessToken, tokenType, expiresIn, public user
    Note over R: F5 destroys the access JWT
    R->>A: POST /auth/refresh (cookie, Origin, CSRF header)
    A->>P: SELECT FOR UPDATE; check expiry/hash/generation; rotate
    P-->>A: Committed new hash, same absolute expiry
    A-->>B: Rotated HttpOnly cookie
    A-->>R: New access JWT and current public user
    R->>A: Business requests: Authorization Bearer
    Note over R: Logout clears memory and records non-secret pending intent
    R->>A: POST /auth/logout (cookie, Origin, CSRF header)
    A->>P: Revoke this refresh-session family
    A-->>B: Clear refresh cookie
    A-->>R: 204; clear pending intent
```

The API and compiled React app share one origin in production. Local Vite development remains available with exact loopback origins. Business authorization and `src/orders/service.ts` are unchanged.

## API contract and expiry

| Endpoint | Request | Successful result | Safe failures |
| --- | --- | --- | --- |
| `POST /api/v1/auth/login` | Existing strict email/password JSON | Existing JSON contract + refresh Set-Cookie | 400 validation, 401 wrong credentials, 403 CSRF/transport, 429 existing rate limit |
| `POST /api/v1/auth/refresh` | Empty JSON `{}`; refresh only from cookie | Same access-token/public-user contract; rotated cookie | 401 absent/malformed/expired/revoked, 403 CSRF/transport, 409 concurrent rotation, 429 rate limit |
| `POST /api/v1/auth/logout` | Empty JSON `{}`; cookie if present | Idempotent 204, revoke family and clear cookie | 400 unexpected fields/query, 403 CSRF/transport; database/network failure is not claimed as success |
| `GET /api/v1/users/me` | Bearer access JWT | Existing id/email/name/role DTO | Existing 401 semantics |

Login failure creates no session. A new successful login replaces/revokes the previously presented browser session, not every device session. Register keeps its existing response and atomic MASTER registration; it now also requires the auth CSRF protocol. Refresh/logout reject body/query identities; the user comes from the locked session FK and current User record. A deleted User cascades only its technical session rows and cannot recover.

* Access JWT: HS256, issuer `fixit-api`, audience `fixit-web`, **900 seconds** in production. A random `jti` makes same-second issuance distinct. Existing signature/issuer/audience/expiry checks remain enabled.
* Refresh: **7-day absolute lifetime**, **24-hour idle timeout**. Successful refresh advances `last_used_at`, never `expires_at`. These are server constants, not client claims.
* **Logout, expiry and replay revocation do not revoke already issued stateless access JWTs.** A copied access JWT can remain usable for the remainder of its 15-minute TTL. The application clears its memory immediately; no full access-token blacklist/introspection is claimed.

## Storage and threat model

Only one technical table is added: `auth_sessions`. The five business tables remain unchanged. Prisma adds the AuthSession model and a User relation; no User SQL column is added. The four-migration sequence is:

1. `20261109200000_init_database_schema` — unchanged.
2. `20261114130000_hybrid_mvp` — unchanged.
3. `20261114150000_review_snapshot_alignment` — unchanged.
4. **`20261116090000_add_auth_sessions`** — additive, transaction-wrapped migration.

| Fields | Purpose / SQL enforcement |
| --- | --- |
| `id`, `user_id` | UUID PK; FK to users with CASCADE for technical sessions when the user is deleted |
| `token_hash` | UNIQUE non-null SHA-256 hex of the entire opaque token; never a plaintext verifier |
| `previous_token_hash`, `generation`, `rotated_at` | One-step hash plus authenticated generation for concurrency/replay; CHECK ties initial/rotated shapes together |
| `created_at`, `last_used_at`, `expires_at` | timestamptz(3), ordered timestamps, fixed absolute expiry; CHECK excludes invalid time shapes |
| `revoked_at`, `revoked_reason` | Both null or a timestamp plus logout/replay/expired; CHECK explicitly rejects a null reason for a revoked row |
| Indexes | UNIQUE token_hash, `(user_id, revoked_at)`, `expires_at`; PK lookup locks one session |

All hashes have an enforced 64-character lowercase hex shape. Generation cannot be negative. DBML and database checks now distinguish **5 business + 1 technical table**, excluding Prisma's migration metadata.

The refresh token is a server-defined **opaque**, non-JWT value. Internally its version/UUID selector/generation/32 cryptographically random bytes are authenticated with HMAC-SHA-256. The MAC key is domain-separated from the environment JWT secret with `fixit.refresh.issuance.v1`. It contains no user identity, role or JWT payload. The random verifier has **256 bits of entropy**; only SHA-256 hashes of full issued values are stored in PostgreSQL.

This design protects against a read-only DB leak: hashes do not permit recovering/brute-forcing the random verifier. The issuance MAC additionally distinguishes an authentic old generation from a fabricated selector/counter, preventing unauthenticated session-revocation/rate-bucket attacks without an unbounded retired-token list or another table. The MAC never replaces the current database hash, expiry, FK or revocation check. A database write compromise, server/key compromise, malicious browser extension or same-origin XSS is outside this protection boundary. HttpOnly prevents JavaScript reading the refresh cookie, but XSS can still make authorized requests and read an access JWT in memory. No claim of XSS prevention or MFA is made.

## Atomic rotation, concurrency and replay

`createSessionService().rotate()` runs a transaction with `SELECT ... FOR UPDATE` for the session. It verifies the current row, times and user, then replaces the current hash and increments generation. Only the transaction winner receives a new refresh cookie/access JWT. No credentials are returned before commit.

An authentic older token within **2 seconds** of the latest rotation receives **409 REFRESH_CONFLICT**, `Retry-After: 1`, **no credentials and no Set-Cookie**. This includes a delayed older-than-immediate generation, whose issuance MAC proves it was real. It does not revoke a legitimate session merely because two requests were close together. An old verifier is never exchanged for credentials again.

Outside that short window, an authentic old generation revokes **only its session family** as replay and returns 401. Its newest verifier then also fails. Another browser/device session remains valid. Forged MACs, malformed/duplicate cookies and unknown selectors cannot revoke a real row. Logout accepts an authenticated older generation for revocation, so a refresh/logout race cannot leave that family active. Explicit revocation is committed before a denial/response is produced.

Frontend single-flight shares one refresh promise per provider. Web Locks serializes cookie-changing login/refresh/logout across same-origin tabs; BroadcastChannel carries only `logout`/`account-changed` events, never tokens or user data. Epoch checks discard responses from a previous user, provider, logout or aborted route request. A 401 business response may trigger **one** refresh and **one** retry; a late concurrent 401 uses an already newer memory token. No refresh loop or automatic retry on 403/network/5xx exists. Ordinary network/5xx/409/429 refresh errors preserve current memory and expose retry; a terminal refresh 401 ends recovery.

**Lost response limitation:** if a committed rotation's Set-Cookie is lost (for example, navigation/network loss while refresh is in flight), the browser may retain a spent verifier. The server fails closed, with conflict/re-login possible; it never reissues credentials for that old verifier. Web Locks/single-flight avoid ordinary application races but cannot make cookie delivery transactional with PostgreSQL. Chromium Web Locks/BroadcastChannel behaviour is tested; browsers without these APIs fall back to the controlled server conflict policy and may need a manual retry.

## Cookies, CSRF, CORS and logout intent

* Production refresh cookie: **`__Host-fixit_refresh; Secure; HttpOnly; SameSite=Lax; Path=/`**, no Domain. Remaining Max-Age/Expires is bounded by the original 7-day expiry. Clearing uses matching attributes.
* Lax allows an external top-level navigation into FixIT to retain the session; all mutations are POST with independent Origin/header checks. SameSite is not the sole CSRF defense. SameSite=None/third-party cookie deployment is not used.
* HTTP development cookie `fixit_refresh_dev` is permitted only when both the raw Host and socket peer are actual loopback. Forwarded Host cannot bypass that check. Production cannot select Secure=false; remote plaintext auth is rejected. The production-like Chromium test uses trustworthy **localhost HTTP with the real Secure production cookie**, not relaxed cookie flags. Real HTTPS/Render TLS remains a separate deployment check.
* Login/register/refresh/logout require an exact allowed **Origin**, `X-FixIT-CSRF: 1`, JSON, and reject `Sec-Fetch-Site: cross-site`. No Origin, foreign Origin, simple form POST or missing header fails. Non-browser clients must supply this protocol too.
* CORS allows exact origins only; credentials are enabled only for auth routes, not wildcard or business routes. Auth fetch uses credentials=include; business fetch uses credentials=omit plus Bearer. All API/auth responses use `Cache-Control: no-store`.
* Existing login/register 30 requests per 15 minutes is preserved. Refresh allows 60/minute per issuance-authenticated session selector, plus an independent 60/minute IP bucket for invalid cookies. An unauthenticated fabricated-cookie flood cannot consume a valid session's refresh budget. Limits are in-process, not distributed; multi-instance abuse controls are not claimed.

Explicit Logout clears access memory immediately. To avoid F5 resurrecting a session after **offline Logout**, React writes a **non-secret** host-only `fixit_logout_pending=1` cookie (production `__Host-fixit_logout_pending`, Secure/Strict/Path=/). It contains no JWT, refresh verifier, user ID or identity. On the next load the client must complete Logout before attempting Refresh; the marker is removed only after success. There are no tokens in localStorage, sessionStorage or IndexedDB, nor credentials in BroadcastChannel/URLs/logs. Server revocation cannot succeed while offline: the UI reports that fact, keeps the logout intent and retries when the server is reachable. Deleting browser state or a malicious same-origin script is outside this guarantee.

## React recovery

AuthProvider exposes bootstrapping/authenticated/anonymous/unavailable. ProtectedRoute waits for bootstrap instead of redirecting prematurely. A valid cookie restores the current user/role and retains the exact protected route, including dashboard, CLIENT/MASTER lists/details and service management. Invalid/no session becomes anonymous; temporary network/5xx failure offers retry without claiming logout. Auth requests have a bounded timeout so bootstrap does not wait forever. Safe `returnTo` validation from PR #10 is retained. Private outlet state is keyed by user ID, so changing accounts cannot preserve the prior account's private cards.

The existing 255 isolated UI fixtures inject access tokens with `recoverSession=false`: they preserve their original business assertions without pretending to implement a cookie server. `main.tsx` uses the live default, and the new session tests plus every real browser scenario exercise live recovery. Existing HTTP auth fixtures were updated for mandatory CSRF; two obsolete F5-to-login expectations now check successful recovery. No old scenario/assertion was removed to obtain PASS. Form drafts remain volatile across F5; FIX-17 restores **authorization**, not unsaved form persistence.

## Executed verification

Environment: Node **24.22.1**, npm **11.9.0**, PostgreSQL **18.6**, Prisma **7.10.1**, Vitest/V8 **5.1.0**, real Chromium. Official Prisma generation works without Rust compilation or disabled TLS/checksum validation. `package-lock.json` and dependencies are unchanged.

| Command / check | Actual result |
| --- | --- |
| `npm ci --include=dev` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | **651/651**, 16 suites (baseline 587 + 64) |
| `npm run frontend:test` | **287/287**, 10 files (baseline 255 + 32) |
| `npm run frontend:build` | PASS, production assets generated |
| `npm run frontend:coverage` | PASS, 287 tests; 12 modules, per-file 71% gates unchanged |
| `npm run test:e2e` | **43/43** (baseline 33 + 10 single-origin session scenarios), Chromium/React/Express/PostgreSQL |
| `npm run db:generate` / `db:validate` | PASS |
| `npm run er:validate` | PASS, six tables and eight FK relationships |
| `npm run db:migrate` / `db:status` / `db:check` | PASS, all four applied; repeat deploy has no pending migration |
| `npm run deploy:validate` | PASS, local single-origin/free-plan invariants; not live Render approval |
| `npm run release:verify` | PASS, complete final command including all 43 browser tests |
| `npm run test:migrations` | PASS, clean + existing-data upgrade; repeat deploy/seed and all four checksums |
| `npm audit --omit=dev` | **0** vulnerabilities |
| `npm audit` | **19** existing dev-tree entries: 3 low, 16 moderate, 0 high/critical |
| Live Render schema request | **BLOCKED**, proxy CONNECT HTTP 403 (not a successful provider validation) |
| Windows 11 / actual Render deployment | **NOT RUN**; no workstation/resource was used |

Coverage, in **Statements / Branches / Functions / Lines** order:

| Module | S | B | F | L |
| --- | ---: | ---: | ---: | ---: |
| All 12 modules | **97.02%** | **90.08%** | **97.94%** | **99.43%** |
| session.ts | 98.50% | 90.78% | 94.44% | 100% |
| api.ts | 97.95% | 88.23% | 100% | 97.29% |
| auth.tsx | 94.44% | 71.42% | 100% | 100% |
| orders.tsx | 96.85% | 89.04% | 100% | 100% |
| CancelOrderDialog.tsx | 96.77% | 95.65% | 100% | 100% |

The original nine measured modules remain included, with auth/api/session added. No difficult branches are excluded. Aggregate percentages have a different scope from PR #11. HTML/JSON coverage and Playwright artifacts remain ignored, not committed.

Backend security tests cover current/older verifier use, concurrency, malformed/forged/duplicate cookies, isolated families, idle/absolute expiry, deletion, valid/invalid Origin/header combinations, transport, rate-bucket isolation, immutable user identity, SQL constraints, stateless JWT expiry/issuer/audience/signature and safe DTO/error/log boundaries. Frontend tests cover bootstrap, errors/retry, stale users/provider responses, logout/F5 intent, single-flight, one-retry-only and no token storage.

The ten new browser scenarios use **built production React and one production-mode Express origin with a real browser cookie jar**. They verify CLIENT orders/both detail types after F5, MASTER assignments/details/feed/services after F5, CUSTOM and STANDARD lifecycles, foreign CLIENT/MASTER privacy, replay and session isolation, idle/absolute expiry, a genuinely expired Bearer JWT followed by refresh/retry, simultaneous two-tab F5, and offline Logout/F5. The expired-JWT case injects an actually expired signed header into the first business request; refresh, cookies and API are real, not mocked auth responses. Browser trace/video/screenshots are disabled to avoid recording credentials. No screenshots are fabricated.

## Database safety and migration evidence

All task writes were restricted to **new loopback databases created for this task**: `fixit_sessions_test` (initial probe, retained), `fixit_sessions_final_test` (final full regression), `fixit_sessions_clean_test` and `fixit_sessions_upgrade_test`. No existing `fixit_dev`, `fixit_test`, `fixit_shadow`, earlier task database or Render database was a test/migration target. No reset, db push, database drop, production seed or existing-data cleanup was performed.

The initial probe contains an earlier unpublished draft of the new technical migration and is not a final checksum/verification target. It was retained rather than reset or rewritten. The private helper points to the newly provisioned final database; final checksum/upgrade evidence uses the final/clean/upgrade databases only.

The migration verifier snapshots all five business tables before/after the fourth migration and asserts equality. It also exercises the unchanged initial/Hybrid/review upgrades, all five legacy order statuses, IDs/timestamps/descriptions, exact prices including 0/1/max legacy integer cents, repeated seed/deploy and all migration checksums. Dedicated databases are retained for inspection; rerunning this verifier requires a **new empty pair**, not clearing the used pair.

Original SQL SHA-256 digests remain:

```text
20261109200000_init_database_schema       2c67b65cc6a5293b7a38683555f8b9caf0964d8d82b3f5e68f4dd482b8cab3ff
20261114130000_hybrid_mvp                 dec3306fd4b73f81c06a570015c5aeb22cb353f46160b22dd4ed5d4e51132918
20261114150000_review_snapshot_alignment  d2a98d6d5098a517ee55ac74500ec7ba13434f24e544551c5a0884ac6070e041
```

`src/orders/` and `src/services/` business implementations, the five business SQL definitions/constraints/triggers and exact monetary model are unchanged. Seeds continue selecting their fixed synthetic IDs.

## Rollout, rollback and residual risks

See [Render deployment/rollback](DEPLOYMENT_RENDER.md), [release gates](RELEASE_CHECKLIST.md), and [future Windows QA](WINDOWS_SESSION_QA.md). There is one free Node web service plus a separate free PG18 definition; no live resource was provisioned. Deployment guards require a relative `/api/v1`, served frontend, production bindings, safe TLS and no test secrets. SPA fallback never handles API/health/dotfiles/missing assets.

The fourth migration is additive: existing business data/old access JWTs remain compatible, but old browser code is **not** a transparent rollback target. It lacks mandatory CSRF headers/server Logout, and the prior split-service Blueprint cannot serve the new single-origin app as-is. Keep the table/migration on an application rollback. Retain a known compatible app artifact/settings; on first rollout no prior deployed compatible artifact exists, so prefer an approved fix-forward/suspension plan. Do not delete auth_sessions or replay applied SQL. Rotating JWT_SECRET invalidates existing JWTs and refresh issuance MACs; keep it persistent across routine deploys.

Residual risks requiring review: already-issued JWT TTL after revocation; XSS/host compromise; lost-rotation response and offline server-revocation limits; in-process rate counters; retained expired/revoked technical rows (no scheduled retention job yet); inherited dev dependency advisories present in the CLI-at-start hosting artifact; absent server-side business-POST idempotency. This task adds neither an idempotency key nor a new business function.

Remaining real Render checks, **after separate deployment approval only**: current free PG18/account quotas/expiry/backups, live Blueprint schema, dashboard auto-sync disabled, HTTPS certificate/edge trust, real public-origin Set-Cookie and cross-tab behaviour, internal DB routing/readiness, production asset/API fallback and ST1–ST5 on the approved SHA. Local Cloud PASS does not assert any of these live outcomes.

## Changed-file map

* Auth/API: `src/auth/{sessions,cookies,router,token}.ts`, `src/{app,config,server}.ts`.
* Database: `prisma/schema.prisma`, the fourth migration above, `docs/er-diagram.dbml`, `scripts/{check-database.ts,validate-dbml.mjs,verify-migrations.mjs}`.
* React: `frontend/src/{session.ts,auth.tsx,api.ts,App.tsx}`, `frontend/vite.config.ts`, test setup and existing UI fixtures; new `sessions.test.tsx`.
* Deployment/verification: `render.yaml`, `package.json`, `scripts/{check-render-blueprint,deployment-config,build-session-frontend}.mjs`, Playwright configs, new `e2e/sessions.spec.ts`, updated existing protocol/F5 browser fixtures, integration/guard/static tests.
* Documentation/examples: this report, deployment/release checklist, Windows session QA, README, MVP specification and root/frontend `.env.example`.

The PR Files changed tab is the complete per-file list; generated artifacts, private environment helpers, real passwords and real connection strings are excluded. Synthetic test fixtures and placeholder examples remain clearly marked.

## Exact changed files

65 files, including one new migration:

```text
.env.example
FIXIT_MVP_SPEC.md
README.md
docs/DEPLOYMENT_RENDER.md
docs/FIX_17_REFRESH_SESSIONS.md
docs/RELEASE_CHECKLIST.md
docs/WINDOWS_SESSION_QA.md
docs/er-diagram.dbml
e2e/auth.spec.ts
e2e/catalog.spec.ts
e2e/lifecycle.spec.ts
e2e/offers.spec.ts
e2e/order-details.spec.ts
e2e/orders.review.spec.ts
e2e/orders.spec.ts
e2e/sessions.spec.ts
e2e/standard.spec.ts
frontend/.env.example
frontend/src/App.test.tsx
frontend/src/App.tsx
frontend/src/api.ts
frontend/src/auth.tsx
frontend/src/lifecycle.test.tsx
frontend/src/offers.test.tsx
frontend/src/order-details.test.tsx
frontend/src/orders.coverage.test.tsx
frontend/src/orders.review.test.tsx
frontend/src/orders.test.tsx
frontend/src/services.test.tsx
frontend/src/session.ts
frontend/src/sessions.test.tsx
frontend/src/standard.test.tsx
frontend/src/test-setup.ts
frontend/vite.config.ts
package.json
playwright.config.mjs
playwright.sessions.config.mjs
prisma/migrations/20261116090000_add_auth_sessions/migration.sql
prisma/schema.prisma
render.yaml
scripts/build-session-frontend.mjs
scripts/check-database.ts
scripts/check-render-blueprint.mjs
scripts/deployment-config.mjs
scripts/validate-dbml.mjs
scripts/verify-migrations.mjs
src/app.ts
src/auth/cookies.ts
src/auth/router.ts
src/auth/sessions.ts
src/auth/token.ts
src/config.ts
src/server.ts
tests/auth.integration.test.mjs
tests/deployment.test.mjs
tests/hybrid.integration.test.mjs
tests/lifecycle.integration.test.mjs
tests/offers.integration.test.mjs
tests/order-details.integration.test.mjs
tests/orders.integration.test.mjs
tests/registration.integration.test.mjs
tests/services.integration.test.mjs
tests/sessions.integration.test.mjs
tests/standard.integration.test.mjs
tests/static.integration.test.mjs
```
