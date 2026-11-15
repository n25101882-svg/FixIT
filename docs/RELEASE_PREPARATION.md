# Підготовка FixIT MVP до Feature Freeze та практичної №11

База: develop після merged PR #10, `2af15f539e0683d2900706e4430f22f641c3e56e`.
Гілка: `chore/release-preparation`. Фактична перевірка: Codex Cloud/Linux, 15.11.2026.

**Статус:** готово до code review; реального Render deployment, Feature Freeze approval, release/v1.0.0, backup/restore або merge не виконано. FIX-17 decision та live/Windows QA залишаються відкритими gates.

## Cleanup і межі змін

- Перевірено console/debugger/TODO/закоментовані фрагменти й прямі залежності. У frontend/runtime business modules зайвих debug logs або вимкнених блоків реалізації не виявлено. Стартовий redacted lifecycle log сервера та результати CLI-перевірок залишені як потрібні operational messages; headers/body/JWT/паролі не логуються.
- Прямі dependencies використовуються runtime, generated Prisma client, типами, тестами або npm tools. Підтверджених зайвих прямих пакетів немає; видалень/оновлень залежностей або force audit fix не виконано. package-lock.json незмінний; нові scripts використовують Node stdlib, без додаткового YAML package.
- Прибрано п’ять повторних правил .gitignore; додано ігнорування private pgpass/backup/secrets paths. Збережено захист .env, node_modules, generated client, dist, coverage, test-results. .env.example більше не задає існуючу shadow DB за замовчуванням; оновлено deployment comments. Node patch pin 24.22.1.
- Нова HTTP-конфігурація — opt-in TRUST_PROXY_HOPS 0/1: локально false, Render — один ingress. Це виправляє конфігурацію rate limiter за proxy без blanket trust=true. Транзакційні правила та JWT/auth модулі незмінні.
- Усі frontend source/tests, бізнес-модулі orders/services/auth, Prisma schema/DBML та три SQL-міграції незмінні. Старі assertions не видалено/не послаблено.

## Security findings

| Перевірка | Фактичний результат / дія |
| --- | --- |
| Git secrets/artifacts | 228 reachable historical blobs перевірено до публікації: немає private-key/GitHub-token/AWS-key patterns, historical private .env/node_modules/coverage/test-results paths. Поточні staged files перевіряються окремо перед commit. Це pattern scan + ручна перевірка конфігурацій, не повний security certification. |
| .env.example | Тільки placeholders/порожній JWT_SECRET, local test URLs; реальних credentials немає. Render використовує окремі private bindings, не цей .env. |
| npm audit --omit=dev | **0 vulnerabilities** у production dependency graph. |
| npm audit | **19 affected-package entries: 3 low, 16 moderate, 0 high/critical**, dev Jest chain; це не 19 незалежних CVE. Review/remediation acceptance потрібне до релізу. |
| Deployment defaults | Explicit HOST/platform PORT/CORS/JWT/DATABASE/VITE guards. Не можна непомітно зібрати frontend із localhost API або перенести test/shadow bindings у deployed API. |
| Transport | npm strict-ssl=true, unsafe TLS/checksum flags відсутні; guards відхиляють disable flags і будь-яке nonempty PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING. Перевірки не вимикалися. External DB вимагає verify-full, provider internal DB — private binding без routing overrides. |
| Proxy | Один bounded hop, default 0, invalid/unbounded settings fail. Supertest довів окремі rate-limit buckets для forwarded clients. Реальну Render ingress topology ще має перевірити оператор. |
| Frontend secrets | Production build містить explicit public API URL, не містить переданих DB/JWT bindings; VITE_* allowlist і відмова від local dotenv у deploy scripts. |
| Provider validation | Public Render docs/schema заблоковані proxy CONNECT 403; offline Blueprint safety checks PASS, live schema/provisioning/PG18/free availability **NOT VERIFIED**. Немає обходу мережі або платного fallback. |

Три первинні advisory identifiers у dev graph:

- deepmerge: [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), prototype poisoning, low.
- glob: [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), cancellation/filesystem traversal resource exhaustion, moderate.
- minimatch: [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), globparts amplification DoS, moderate.

Propagation зачіпає Jest/@jest/*, babel-jest/babel-plugin-istanbul і test-exclude. Частина entries має fixAvailable, але direct pinned Jest chain не має повного автоматичного виправлення. Не підміняємо audit результат force/major update без окремої перевірки сумісності. Dev tools не входять у HTTP business imports, але **залишаються встановленими** в запропонованій free deployment-схемі, оскільки Prisma CLI потрібен на старті. Це явний залишковий ризик, не твердження про vulnerability-free artifact.

## Фактичні перевірки

Node 24.22.1, npm 11.9.0, PostgreSQL 18.6, Prisma 7.10.1, Vitest/V8 5.1.0. Нові loopback БД: fixit_release_test, fixit_release_clean_test, fixit_release_upgrade_test. Існуючі fixit_dev/fixit_test/fixit_shadow не використовувалися як targets і не очищувалися. Жодного reset/db push/drop; приватний release-env.sh поза Git.

| Команда / перевірка | Фактичний результат |
| --- | --- |
| npm ci --include=dev | PASS, lockfile unchanged, штатне встановлення |
| npm run release:verify | PASS: усі підкоманди завершилися успішно |
| npm run typecheck | PASS |
| npm test | **586/586**, 14 suites; попередні 516 + 70 deployment/configuration cases |
| npm run frontend:test | **255/255**, 9 files, усі попередні збережені |
| npm run frontend:build | PASS, TypeScript/Vite production build |
| npm run frontend:coverage | **255/255**, усі 9 per-file gates 71% пройдені |
| npm run test:e2e | **33/33**, усі 6 груп 15/4/3/3/4/4, реальний React/JWT/PostgreSQL |
| db:generate / db:validate / er:validate | PASS; Prisma 7.10.1, 5 tables / 7 FK |
| db:migrate / db:status / db:check | PASS; усі 3 міграції, повторний deploy без змін, connection/schema OK |
| npm run test:migrations | PASS; fresh + initial→Hybrid→review upgrade, repeat deploy/seed, legacy rows/prices/history preserved |
| npm run deploy:validate | PASS, **локальні safety invariants**, не live Render schema |
| npm run deploy:build:api | PASS, Prisma Generate + tsc |
| npm run deploy:build:frontend | PASS з explicit HTTPS VITE_API_URL; перевірено відсутність переданих private bindings у bundle |
| Clean static checkout без DB/JWT bindings | PASS: окрема тимчасова копія лише repository files → npm ci --include=dev → deploy:build:frontend; приватна DB не потрібна для static build |
| Local npm run deploy:start | PASS на fixit_release_test: preflight → migrate deploy → compiled API, health/readiness 200, allowed CORS 200, untrusted Origin 403, protected route без JWT 401 |

Coverage обраних 9 frontend-модулів: **Statements 96.87% (652/673), Branches 90.22% (674/747), Functions 98.63% (145/147), Lines 99.48% (388/390)**. Відсотки та thresholds незмінні; жодних exclusions або зниження gates. Backend coverage не вимірювався. Generated HTML/JSON/results у Git не додаються.

Migration verifier фактично підтвердив 5 legacy Orders / усі старі statuses, IDs, timestamps, descriptions і точні ціни 0/1/max integer cents; nullable biography; атомарну відмову для unsupported category без втрати даних; review invariants/rollback попередніх записів у транзакції. Checksums усіх 3 SQL збігаються з base. Тестові БД залишені для inspection.

Нові 70 tests перевіряють bounded proxy/real HTTP rate-limit isolation, production env preflight, required/redacted secret configuration, external TLS/internal DB/локальний rehearsal, reserved DB protection, dotenv/VITE leak prevention та негативні Blueprint changes (paid plans, autodeploy, paid hook, public DB, wrong PG, duplicate/secret bindings, missing SPA).

Локальний production command і production bundle використовували synthetic public URL format examples; це не live domains цього проєкту. Немає твердження про Render deployment, HTTPS certificate, hosted SPA fallback, provider edge, live smoke ST1–ST5 або виконану Windows QA. Вони перевіряються оператором після окремого схвалення.

## Render, checklist і ручні дії

- [render.yaml](../render.yaml): free API/static/PG18, autodeploy off, private DB reference/generated JWT, sync:false public domains, healthCheckPath=/health/ready, SPA rewrite/security headers.
- [DEPLOYMENT_RENDER.md](DEPLOYMENT_RENDER.md): environment matrix, approval gates, Windows/Codex verification, approved deployment steps, backup/restore та app-only rollback. Free startup migrations не залежать від paid preDeployCommand.
- [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md): Feature Freeze gates, рішення FIX-17/idempotency/dev advisories, ST1–ST5 та release approval.
- [PRACTICAL_11_RESULTS_TEMPLATE.md](PRACTICAL_11_RESULTS_TEMPLATE.md): **NOT RUN** для реального deploy, Windows, screenshots, backup/rollback/smoke. Заповнювати лише фактичними доказами.

Потрібні ручні рішення: завершити FIX-17 decision/QA; оцінити відсутність server idempotency та dev advisories; у Render перевірити free PostgreSQL 18, quota/expiry/backup/ingress/schema; надати actual domains і private bindings; схвалити створення ресурсів/initial deployment окремо; після нього виконати ST1–ST5 та заповнити results. Не створювати release/v1.0.0 до gates. Merge залишається за користувачем/reviewer.

## Змінені файли

- Runtime HTTP configuration: src/config.ts; src/app.ts; src/server.ts.
- Safe automation: scripts/deployment-config.mjs; scripts/check-deploy-env.mjs; scripts/check-release-test-env.mjs; scripts/check-render-blueprint.mjs; package.json.
- Configuration/cleanup: render.yaml; .nvmrc; .env.example; frontend/.env.example; .gitignore.
- Tests: tests/deployment.test.mjs.
- Docs: README.md; docs/DEPLOYMENT_RENDER.md; docs/RELEASE_CHECKLIST.md; docs/PRACTICAL_11_RESULTS_TEMPLATE.md; docs/RELEASE_PREPARATION.md.

Жодних нових бізнес-функцій, таблиць, міграцій, auth/session persistence, server idempotency-key, зовнішніх повідомлень, платних ресурсів або реального deploy. Попередні практичні звіти не переписано.
