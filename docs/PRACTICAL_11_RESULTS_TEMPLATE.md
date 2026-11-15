# Practical №11 — deployment and smoke results template

**Status: NOT RUN.** This is a blank evidence template, not a claim that Windows QA, Render deployment, backup or rollback occurred. Actual Cloud preparation checks are recorded separately in [RELEASE_PREPARATION.md](RELEASE_PREPARATION.md).

## Execution context

| Field | Fill with actual value |
| --- | --- |
| Operator / date / timezone | NOT RECORDED |
| Approval reference for resources/deployment | NOT APPROVED |
| Environment (Windows / Codex Cloud / Render) | NOT RECORDED |
| Approved candidate SHA | NOT RECORDED |
| Actual API deployed SHA | NOT DEPLOYED |
| Actual static deployed SHA | NOT DEPLOYED |
| Public API/frontend URLs (no credentials/query tokens) | NOT DEPLOYED |
| Node/npm/PostgreSQL/Prisma versions actually observed | NOT RECORDED |
| Render live Blueprint validation / PG18/free plan / quotas | NOT VERIFIED |
| DB migration count/checksums (no connection string) | NOT RECORDED |
| Backup identifier/checksum + successful restore drill | NOT RUN |

## Build and QA evidence

| Command/check | Actual result | Evidence reference |
| --- | --- | --- |
| npm ci / production builds | NOT RUN | NOT CAPTURED |
| npm run release:verify (isolated *_test only) | NOT RUN | NOT CAPTURED |
| npm run test:migrations (new empty *_test pair only) | NOT RUN | NOT CAPTURED |
| npm audit --omit=dev / npm audit | NOT RUN | NOT CAPTURED |
| Render health/readiness / SPA assets / CORS | NOT RUN | NOT CAPTURED |
| Windows 11 manual QA | NOT RUN | NOT CAPTURED |

| Smoke ID | Actual UTC timestamp | API/static SHA | PASS/FAIL/BLOCKED/NOT RUN | Evidence / observed result |
| --- | --- | --- | --- | --- |
| ST1 Frontend/SPA | — | — | NOT RUN | NOT CAPTURED |
| ST2 API/readiness/catalog | — | — | NOT RUN | NOT CAPTURED |
| ST3 Auth/access | — | — | NOT RUN | NOT CAPTURED |
| ST4 STANDARD | — | — | NOT RUN | NOT CAPTURED |
| ST5 CUSTOM | — | — | NOT RUN | NOT CAPTURED |

Follow [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) and [DEPLOYMENT_RENDER.md](DEPLOYMENT_RENDER.md). Record actual HTTP statuses, synthetic Order IDs and real DB/timeline results. Screenshots must be captured by the operator; redact Authorization/JWT, passwords, secret settings, connection strings and personal data. Do not assign another team member work they did not perform.

## Decisions and blockers

| Item | Decision / owner / date / approval reference |
| --- | --- |
| FIX-17 session/draft loss after F5 | NOT DECIDED |
| No server-side idempotency / ambiguous POST duplicate risk | NOT DECIDED |
| Dev dependency advisory acceptance/remediation | NOT REVIEWED |
| Free provider limits / backup durability / external access | NOT VERIFIED |
| Remaining defects / release approval | NOT APPROVED |

## Rollback / recovery record

Rollback executed: NOT RUN. Reason, incident time, last-good approved artifact, matching settings, actual post-rollback API/static SHAs, schema compatibility, health/smoke evidence: NOT RECORDED.

Database restored: NOT RUN. If authorised later, identify the new empty recovery DB and approved backup/restore verification without credentials. Do not reset/overwrite/delete the original DB. An app rollback is not a database rollback.

Release/v1.0.0 creation and final approval: NOT AUTHORISED until FIX-17 decision and QA gates are complete. No merge is implied by this template.
