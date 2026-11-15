# FixIT Feature Freeze and release checklist

Candidate: chore/release-preparation from develop after PR #10 (2af15f5). This checklist does not approve deployment, merge or release/v1.0.0. Local verification evidence is in [RELEASE_PREPARATION.md](RELEASE_PREPARATION.md); live deployment results belong in [PRACTICAL_11_RESULTS_TEMPLATE.md](PRACTICAL_11_RESULTS_TEMPLATE.md).

## Gates before Feature Freeze / release branch

- [ ] Preparation PR reviewed and merged manually; exact candidate SHA recorded.
- [ ] Scope frozen: existing Auth, catalog/services, CUSTOM/STANDARD, offers, lifecycle/details only. No schema/business-rule/JWT changes hidden in cleanup.
- [ ] All 3 applied SQL files and 5-model Prisma/DBML checked unchanged; backups/data are preserved.
- [ ] Reproduce npm ci and release:verify on an allowed dedicated *_test DB; retain actual test/coverage results, not generated reports in Git.
- [ ] Fresh/legacy-upgrade migration verification on a new empty pair; repeat deploy/seed and exact old-price/history preservation checked.
- [ ] Review production audit and remaining dev advisories; document acceptance/remediation owner and deadline. No force/major dependency update to hide a finding.
- [ ] FIX-17 decision completed by owner, with QA implications and acceptance or separate architecture work explicitly recorded.
- [ ] Server-side idempotency limitation reviewed; ambiguous-POST/manual retry QA completed and risk accepted or separately remediated.
- [ ] Windows 11 QA and reviewer approval recorded; no fabricated screenshots/contributions.
- [ ] Only after these gates: owner may authorise release/v1.0.0 creation. This PR creates neither branch nor tag.

## Known risk decisions

| Risk | Current behaviour | Required decision |
| --- | --- | --- |
| FIX-17 | JWT/draft live in React memory; F5 needs login. Safe returnTo preserves only allowed route context, not the session/draft. | NOT DECIDED: accept documented MVP UX constraint, or design/test separate auth/session change before release. No localStorage workaround here. |
| No server-side idempotency | Duplicate clicks blocked in UI; ambiguous network/5xx response may follow a committed POST. History inspection and manual retry cannot guarantee exactly-once. | NOT DECIDED: accept residual duplicate-order risk or schedule a separate API/DB design. No idempotency-key added here. |
| Dev advisories in installed tree | 19 npm audit entries (3 low / 16 moderate), Jest chain; prod-only graph 0. CLI-at-start requires keeping dev tools on free hosting. | REVIEW REQUIRED: approved risk/remediation plan; do not call the whole artifact vulnerability-free. |
| Provider/free limits | Free PG18 availability, expiry, quotas, backups/PITR, ingress details and live schema not checked remotely. | VERIFY in dashboard, budget $0, explicit approval before resource creation. No silent paid fallback. |

Decision record fields: issue, owner, date, chosen option, rationale, residual risk, QA evidence, follow-up/deadline, explicit approval reference. Keep secrets out. None is pre-approved by Codex.

## Before real deployment

- [ ] Separate approval for initial resource creation/deployment recorded.
- [ ] Render Blueprint remotely validated; free PostgreSQL 18/region/account quotas confirmed; new resources only.
- [ ] Both autoDeployTrigger values off; exact approved commit(s) selected. Initial Blueprint Apply can still deploy.
- [ ] Actual CORS_ORIGINS/VITE_API_URL set; private JWT_SECRET generated and retained; internal DATABASE_URL correct; no test/shadow bindings or .env files deployed.
- [ ] HOST/PORT/one-hop proxy verified for platform; TLS/checksum verification on; no blanket proxy trust.
- [ ] SPA rewrite/assets, /health and /health/ready checked after deployment.
- [ ] For an environment with data: approved backup/restore drill and last-good artifact/settings ready; no destructive DB rollback.
- [ ] ST1–ST5 completed with actual environment/SHA/evidence; NOT RUN remains until executed.

## Smoke tests ST1–ST5

Use only synthetic QA users and approved environment data. Production smoke is a separate approved operation. Preserve completed/declined/cancelled records. Never use npm tests/seed/migration verification on production.

| ID | Steps | Expected result / evidence |
| --- | --- | --- |
| ST1 — Frontend/SPA | Open /catalog, /login and direct order-details URL; load assets, then refresh. | HTTPS page/assets 200, no localhost/mixed-content/bundle-secret exposure. Protected F5 → login and safe return, consistent with FIX-17. Record Network and actual frontend SHA. |
| ST2 — API/readiness/catalog | GET /health, /health/ready, /api/v1/catalog/services; request with allowed and untrusted Origin. | Health/readiness 200, database up; public catalog 200, allowed CORS exact, untrusted Origin 403. Readiness must fail when DB genuinely unavailable (test only in isolated/approved fault exercise). |
| ST3 — Auth/access | Login CLIENT/MASTER, GET users/me; missing/expired JWT; wrong-role/foreign details. | Correct role/public DTO, no passwordHash; 401 without valid token, 403 wrong role, foreign/missing details same 404. No raw actor IDs/client identity in MASTER detail. |
| ST4 — STANDARD | CLIENT books active Service, MASTER accepts and completes; inspect both details. Separate synthetic pending row → DECLINED/CANCELLED. | 201 PENDING; 200 ACCEPTED → IN_PROGRESS → COMPLETED; fixed price/snapshot/history preserved, terminal records readable, no cancellation after work. Ambiguous POST is not auto-retried; inspect history before manual retry. |
| ST5 — CUSTOM | CLIENT creates OPEN, matching MASTER responds, CLIENT selects, MASTER executes; refresh both details. Try duplicate offer/foreign access; separate OPEN row → CANCELLED. | 201, offer once/duplicate 409, atomic single executor, ACCEPTED → IN_PROGRESS → COMPLETED DB timeline, own-only details, cancelled record retained. Record real DB SELECT without credentials/audit IDs. |

Local evidence covers the production frontend build/API URL (part of ST1), API health/readiness/CORS (part of ST2) and unauthenticated protection (part of ST3). Render static rewrite/HTTPS/edge behaviour was not exercised. ST4/ST5 full workflows are covered by isolated browser regression; repeat real deployed smoke after approval. None of these is a live Render smoke pass.

## After QA / rollback

- [ ] Results template filled with real timestamps, SHAs, statuses, redacted evidence and remaining blockers.
- [ ] Compare API/static commit/settings after any rollback; rerun relevant smoke tests.
- [ ] PostgreSQL is not reverted by an app rollback; original DB retained. Restore only into a new approved empty DB.
- [ ] Owner approves release after FIX-17 decision, QA/security and all remaining gates. No automated merge/release action.
