# FixIT Feature Freeze and release checklist

Current candidate: `fix/fix-17-refresh-sessions`, based on develop after PR #11 (`2887f5417c88914d07490f8debd9959c19862628`). The owner's FIX-17 architecture decision is implemented and ready for code review; this checklist does not approve merge, deployment or release/v1.0.0. [Current automated/security evidence](FIX_17_REFRESH_SESSIONS.md), [deployment/rollback](DEPLOYMENT_RENDER.md), [future Windows QA](WINDOWS_SESSION_QA.md). The earlier release-preparation report and practical #11 results template remain historical/unfilled as appropriate.

## Completed Cloud gates for this PR

- [x] Access JWT remains memory-only; rotating hashed PostgreSQL refresh sessions implement F5 recovery without token Web Storage.
- [x] Five business tables/constraints/triggers, src/orders/service.ts and src/services preserved; first three migrations unchanged, one additive technical migration tested.
- [x] npm ci --include=dev and release:verify on newly created loopback *_test only: 651 backend / 287 frontend / 43 Chromium E2E passed.
- [x] Production frontend build, TypeScript, Prisma Generate/Validate/Status, DB/ER checks and local Blueprint validation passed.
- [x] Coverage gates remain 71% per file; original nine modules retained, three auth modules added. All12: S97.02/B90.08/F97.94/L99.43%.
- [x] Fresh migration and existing-data upgrade, repeat deploy/seed, four checksums and exact business snapshot preservation passed. No reset/db push/drop or existing DB changes.
- [x] Real browser production-mode single-origin cookie jar tested for CLIENT/MASTER F5, expiry, replay, Logout, two tabs, offline Logout intent and CUSTOM/STANDARD flows.
- [x] Security findings/residual limitations documented. No secrets, credential screenshots, generated coverage or private .env files committed.

## Gates before Feature Freeze / release branch

- [ ] This PR reviewed and merged manually; exact candidate SHA recorded. No automated merge.
- [ ] Owner/reviewer accepts or remediates refresh residual risks: stateless access TTL after Logout, lost-rotation response, offline revocation, XSS boundary, retained technical rows and in-process limits.
- [ ] Inherited dev advisories reviewed with an acceptance/remediation owner and deadline. No force/major dependency update to conceal findings.
- [ ] Server-side business-POST idempotency limitation accepted or separately designed. Ambiguous committed POST is not automatically retried by UI.
- [ ] Any additional platform QA is scheduled with an available operator. Windows manual checks are NOT RUN now and are **not a prerequisite for this PR**; the owner has no PC access and Cloud automated evidence is provided.
- [ ] Only after review, QA/security decisions and release approval may the owner authorise release/v1.0.0. This task creates neither branch nor tag and changes no Jira state.

## Known risk decisions

| Risk | Current behaviour | Remaining action |
| --- | --- | --- |
| FIX-17 | Owner chose hybrid auth; implemented/tested F5 recovery via HttpOnly rotating cookie. JWT stays in React memory. Unsaved drafts remain volatile. | Code/security review; do not call the Jira ticket closed or production verified before those actions occur. |
| Stateless JWT after Logout/replay | Refresh family revoked, browser memory cleared; copied access JWT can remain usable for the rest of its15-minute TTL. | Explicitly review this security tradeoff; no full access-token revocation is claimed. |
| Rotation delivery / offline Logout | Lost committed Set-Cookie can require re-login; offline Logout uses a non-secret pending marker and retries server revocation. | Accept fail-closed/recovery limits; do not reuse spent verifier credentials. |
| No server-side idempotency | UI blocks duplicate clicks, but ambiguous POST can already be committed. History/manual retry cannot guarantee exactly-once. | Separate acceptance or API/DB design; no idempotency-key in this task. |
| Installed dev advisories | Full npm audit19 (3low/16moderate), production-only0. CLI-at-start keeps dev tools on host. | Approved remediation/risk plan; not a vulnerability-free artifact. |
| Provider/free limits | Real Render schema/PG18/free expiry/backups/edge not verified; schema network request blocked by proxy CONNECT403. | Confirm before approved resource creation; no paid fallback. |

Decision records should include owner/date/rationale/residual risk/QA evidence/follow-up/approval, without secrets. Automated tests do not grant deployment or risk acceptance.

## Before real deployment — all NOT RUN here

- [ ] Separate approval for initial resource creation/deployment recorded.
- [ ] Live Blueprint schema, current free Node/free PG18 availability, region, account quotas and new resource names confirmed.
- [ ] autoDeployTrigger:off and **dashboard Blueprint automatic sync off** confirmed; initial Apply can still deploy. Exact approved SHA selected.
- [ ] One Node service serves frontend/API; SERVE_FRONTEND=1, VITE_API_URL=/api/v1, exact same-origin HTTPS CORS_ORIGINS, persistent private generated JWT_SECRET, internal DATABASE_URL; no test/shadow/local .env deployment bindings.
- [ ] Production TTL900, platform HOST/PORT, actual one-hop ingress provenance and HTTPS transport verified without weakening TLS/checksum validation.
- [ ] Real browser Secure/HttpOnly/host-only cookie, CSRF denials, rotation, F5 paths, Logout and multi-tab behaviour checked on actual deployed origin.
- [ ] SPA assets/direct navigation verified; unknown API/health never HTML; liveness/readiness checked.
- [ ] For data-bearing deployments: authorised backup/restore drill and compatible app recovery plan. Four applied SQL files retained; no destructive rollback.
- [ ] ST1–ST5 recorded with real timestamp/SHA/status/evidence. A Cloud PASS is not a live Render smoke PASS.

## Smoke tests ST1–ST5

Use synthetic users/records in an explicitly approved environment. No test runner, seed, reset or migration verifier against Render/production. Redact Authorization, Set-Cookie, Cookie, passwords, private identities and connection strings from evidence.

| ID | Steps | Expected evidence |
| --- | --- | --- |
| ST1 — Frontend/SPA | Open catalog/login and direct own CLIENT/MASTER detail URL; refresh, load assets, request missing API/health path. | HTTPS page/assets200; protected F5 retains valid session/current URL; missing API/health JSON404, no mixed content or bundle secrets. Record one deployed service SHA. |
| ST2 — API/readiness | GET health/readiness/catalog; use allowed and untrusted Origin. | Health/readiness/catalog200; exact CORS, foreign Origin403. DB-unavailable503 only in separately approved isolated fault exercise. |
| ST3 — Sessions/access | CLIENT/MASTER login; F5; users/me; refresh rotation; Logout/F5; wrong-role/foreign detail checks. | Correct role/public DTO, no plaintext verifier, cookie attributes and401/403/404 correct. Spent verifier never yields credentials. Old access JWT TTL limitation acknowledged. |
| ST4 — STANDARD | CLIENT books active service, MASTER accepts/starts/completes; own details/F5. Separate pending row declined/cancelled. | PENDING→ACCEPTED→IN_PROGRESS→COMPLETED; exact snapshots/history retained, no cancellation after start. Ambiguous POST is not auto-retried. |
| ST5 — CUSTOM | CLIENT creates OPEN; matching MASTER offers; CLIENT selects; MASTER executes; own details/F5. Check duplicate/foreign access and separate OPEN cancellation. |201, duplicate409, one executor, timeline/terminal record retained; foreign safe404. Redacted authorised DB SELECT corroborates state. |

All43 local browser tests passed, including these business flows and real cookie recovery; real Render HTTPS/edge/provider provisioning and live ST1–ST5 remain NOT RUN.

## After approved deployment / rollback

- [ ] Record actual evidence in the practical #11 template, without backfilling unperformed checks.
- [ ] Compare the single service SHA/settings after rollback and repeat session/SPA/readiness/ST1–ST5.
- [ ] Keep PostgreSQL/four migrations intact. Restore only into a newly authorised empty DB, retaining the original.
- [ ] Do not roll back directly to the old split-service/CSRF-unaware app; use a compatible artifact or an approved fix-forward/suspension plan.
- [ ] Owner approves release after remaining gates. No automatic merge, deployment, Jira changes or release action.
