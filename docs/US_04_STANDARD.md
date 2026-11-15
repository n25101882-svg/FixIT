# STANDARD Orders — US-04 + US-08

База: develop після PR #8, `ad6357ae5fe9f62ac5302bdb5f3d6d2c03bb4518`.
Гілка: `feature/us-04-standard-orders`. Jira: FIX-4 / FIX-8; інтеграція FIX-3 / FIX-9.
Перевірено 15.11.2026, Codex Cloud/Linux. PR до develop, без автоматичного merge.

## Повний сценарій

Guest/CLIENT обирає активну послугу через /catalog або /masters/:id. Кнопка веде на `/orders/new/standard/:serviceId`; guest потрапляє на /login?returnTo=..., після login повертається до вибраного service UUID. Register/login links і успішна CLIENT-реєстрація також зберігають цей контекст. Дозволено лише точний STANDARD path з UUID: не external URLs, //host, інші paths, query/hash/traversal чи control characters. Контекст не містить JWT; token лишається in-memory, FIX-17 не виправляється.

CLIENT бачить актуальні назву, майстра, місто, категорію **послуги** й optional estimate. Місто readonly, є обов’язковий checkbox підтвердження. Description обов’язкове; UI пояснює, що за потреби можна вказати район, точна адреса зараз не потрібна. Нової address/district колонки немає. Null price — «Ціна за домовленістю», не нуль.

Після POST 201 показується реальний success/PENDING із посиланням на /orders; форма прибрана, repeated click не створює новий POST. CLIENT має спільну STANDARD/CUSTOM історію з типом, історичними title/category/city/priceAtOrder, executor name, датою й статусом. STANDARD не показує CUSTOM offers. PENDING/ACCEPTED можна логічно скасувати через чинний діалог/DELETE; після початку/terminal станів кнопки немає й сервер повертає 409. Записи не видаляються.

MASTER бачить тільки свої CUSTOM та STANDARD. STANDARD PENDING має «Прийняти»/«Відхилити»; ACCEPTED → «Розпочати роботу», IN_PROGRESS → «Завершити роботу» для обох типів. DECLINED/CANCELLED/COMPLETED readonly, записи залишаються. Вся транзакційна матриця/ownership/history — у **незмінному transition()** та наявних SQL triggers. 409 запускає GET assigned, 401 — logout, 403 блокує наступну мутацію, невдалий sync лишає картку й блокує stale action.

## API-контракт

Prefix `/api/v1`. Нові маршрути — тільки CLIENT JWT, поточна роль з БД. MASTER/ADMIN не можуть оформити STANDARD як CLIENT.

| Метод | Вхід | Успіх |
| --- | --- | --- |
| GET `/orders/standard/:id` | Service UUID, без query | 200 `{service,snapshot}` — active Service/public Master/preview fingerprint |
| POST `/orders/standard` | serviceId, description, optional expectedSnapshot | 201 `{order}` — commit-нутий CLIENT Order DTO |
| GET `/orders` | Чинний CLIENT маршрут | 200, shared власна STANDARD/CUSTOM історія |
| GET `/master/orders/assigned` | Чинний MASTER маршрут | 200, усі Orders свого MasterProfile, newest first |
| PATCH `/master/orders/:id/status` | Чинний `{status}` | 200, safe MASTER DTO; STANDARD PENDING → ACCEPTED/DECLINED, далі спільний lifecycle |
| DELETE `/orders/:id` | Чинний CLIENT owner маршрут | 200 CANCELLED до роботи, без фізичного DELETE |

Мінімальний request відповідає публічному контракту:

```json
{
  "serviceId": "30000000-0000-4000-8000-000000000099",
  "description": "Необхідно замінити змішувач, тестовий район."
}
```

Це synthetic UUID для прикладу, не гарантія наявного Service. UI додатково надсилає `expectedSnapshot`, отриманий з GET preview — lowercase SHA-256 hex із 64 символів. Сервер порівнює його під locks; він не задає поля Order. Profile city/type/status/title/category/priceAtOrder/clientId/masterProfileId **не приймаються** з body. Усі unknown поля й query overrides відхиляються strict Zod. Description trim 1–4000; UUID та fingerprint валідовані.

`service` preview містить id/title/category/nullable description/nullable fixed-two priceEstimate/isActive=true та public master (profile id, name, city, main category, nullable description). Не містить User.id/email/passwordHash/JWT/approval/audit/order data. Preview читається RepeatableRead. Hash обчислюється з service ID, його owner profile, title, Service.category, profile city, exact/null price — лише з даних, що визначають Order snapshot.

201 повертає чинний CLIENT Order DTO: id/clientId/type/serviceId/masterProfileId/title/description/city/category/status/budget/priceAtOrder/createdAt/updatedAt/statusHistory/assignedMaster/completedAt. Власний CLIENT history контракт збережено; це не public catalog. MASTER DTO не розкриває clientId, email, passwordHash чи raw audit history; додано serviceId і priceAtOrder для відображення STANDARD snapshot. Money — fixed-two decimal string або null.

| HTTP | Умова |
| --- | --- |
| 400 | Invalid UUID/body/description/fingerprint/query, unknown/protected fields |
| 401 | Missing/invalid/expired/wrong-key JWT, deleted account |
| 403 | MASTER/ADMIN у CLIENT API; чужий MASTER/CLIENT на MASTER mutation; чужий CLIENT cancellation |
| 404 | Service відсутня; preview inactive/missing має однаковий safe 404 |
| 409 | Service inactive на POST, preview changed, owner race, P2034 transaction conflict; недозволений/повторний/конкурентний status transition |

CLIENT може замовити будь-яку активну публічну Service, зокрема іншого майстра; server derive-ить саме її реального owner. «Foreign» masterProfileId у payload заборонений, а не використаний для призначення. INTERNAL optional masterProfileId у createStandard() збережений **як assertion** старих callers/tests; публічний API його не приймає.

## Atomic snapshot та конкурентні зміни

Єдиний createStandard(): actor CLIENT → lookup owner Service → **Profile FOR SHARE → Service FOR SHARE** → повторне читання → active/owner/optional fingerprint check → Order STANDARD/PENDING. MasterProfile city й Service title/category/price блокуються до commit. Owner lookup не є довіреним snapshot: owner повторно перевіряється після locks. Відсутність/неактивність/конфлікт не залишають часткового Order.

Порядок узгоджений з US-02 CRUD (Profile SHARE/UPDATE → Service UPDATE), без дублювання createStandard або transition. Service/category/price і profile city, зафіксовані в Order, належать одному узгодженому стану. Подальші зміни не переписують snapshots/history; hiding забороняє **нові** замовлення, а не видаляє раніше створені.

Реальні PostgreSQL barrier tests перевіряють:

1. Writer тримає Profile/Service lock, атомарно приховує або змінює city/title/category/price; HTTP POST очікує (`pg_blocking_pids`), потім 409 без Order або 201 з усім новим набором полів.
2. createStandard вже сформував Order у ще не commit-нутій транзакції; конкурентний profile/service CRUD очікує його locks. Після commit редагування завершується, але Order зберігає попередній узгоджений snapshot.
3. Конкурентні ACCEPTED/DECLINED PATCH → один 200, один 409, одна DB history подія.

`expectedSnapshot` — optional для мінімального API body, **завжди використаний UI**. Якщо майстер змінив ціну/назву/категорію/місто після preview, UI отримує 409, перечитує дані, зберігає description і скидає city checkbox. Повторне підтвердження потрібне навіть коли нове місто/ціна користувачу не підходить; автоматичного POST немає. API caller без fingerprint отримує поточний цілісний DB snapshot, без гарантії відповідності раніше переглянутому preview.

## Неоднозначна відповідь POST

400 лишає текст/field errors; 401 завершує сесію, 403 прибирає CLIENT форму, 404 блокує недоступну послугу. 409 зберігається окремо від load error, stale submit недоступний до успішного GET і повторного checkbox.

5xx/network/нечитабельна success-відповідь не стають success і **не повторюють POST**. Є inline «Перевірити мою історію»: чинний owner-only GET /orders, останні до п’яти STANDARD цієї Service з номером/датою/статусом/описом. Це не автоматичне визначення успіху конкретного запиту. Після успішного GET потрібен окремий explicit retry checkbox та city acknowledgement. Failed history GET, 401/403 не дозволяють повтор. Description лишається у формі.

**Залишковий ризик:** server idempotency-key не додано. Exactly-once не гарантується; попередній запит може завершитися після перевірки історії, а свідомий ручний повтор — створити ще один Order. Повторне замовлення тієї ж послуги саме по собі валідне, тому унікальність client/service не вводиться. Після F5/нової сесії in-memory draft і uncertainty state не зберігаються (FIX-17); перевірте історію перед повторним оформленням.

## Фактичні перевірки

Node 24.22.1, npm 11.9.0, PostgreSQL 18.6, Prisma 7.10.1, Vitest/V8 5.1.0. Нова loopback **fixit_standard_test**, приватний helper `/workspace/.fixit-dev/standard-env.sh` поза Git. Усі три чинні міграції застосовані з нуля, schema up to date. Без fixit_dev, production credentials, db reset/db push або вимкнення TLS/checksum/DB guards.

| Команда | Результат |
| --- | --- |
| `npm run typecheck` | Успішно |
| `npm test` | **428/428**, 12 suites — попередні 376 + 52 STANDARD integration |
| `npm run frontend:test` | **205/205**, 8 files — попередні 151 + 54 нових |
| `npm run frontend:build` | TypeScript + Vite успішні |
| `npm run frontend:coverage` | **205/205**, усі 7 per-file gates 71% пройдені |
| `npm run test:e2e` | **29/29** — попередні 25 + 4 STANDARD |
| `npm run db:validate` | Prisma schema valid |
| `npm run er:validate` | DBML valid: 5 таблиць / 7 FK |
| `npm run db:status` / `db:check` | 3 migrations up to date; connection/schema OK |

Coverage розширено, пороги не знижено, складні гілки не виключено. HTML/JSON у frontend/coverage/ поза Git.

| Модуль | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| standard-order.tsx | 97.58% | 89.43% | 100% | 100% |
| standard-return.ts | 100% | 100% | 100% | 100% |
| master-orders.tsx | 96.24% | 90.97% | 100% | 100% |
| orders.tsx | 96.85% | 89.04% | 100% | 100% |
| catalog.tsx | 91.22% | 87.87% | 90.90% | 93.54% |
| master-services.tsx | 97.97% | 86.79% | 100% | 100% |
| CancelOrderDialog.tsx | 96.77% | 95.65% | 100% | 100% |
| Разом ці 7 модулів | 96.64% | 89.26% | 98.54% | 99.43% |

Це coverage обраних frontend modules, не всього проєкту/backend. Fully covered standard-return.ts підтверджено JSON summary. Backend statement coverage не вимірювався.

Нові integration cases: strict body/role/JWT/ownership, 201/PENDING у двох кабінетах, null/zero/max Decimal, versioned preview, inactive/missing, spoofed executor/client/price/status, реальні lock races, immutable snapshots, accept/decline/start/complete/cancel, конкурентні decisions, shared CUSTOM/STD history, private DTO isolation.

Нові frontend cases: active buttons, guest login/register return allowlist та negative redirects, CLIENT/MASTER access, city acknowledgement/description, 400/errors/draft retention, pending/duplicate guards, 409/resync, ambiguous POST/history/manual retry, 401/403, MASTER decisions і CLIENT terminal history/cancellation. Чотири старі файли очікувань адаптовані до тепер активного STANDARD: offers.integration, lifecycle.test, services.test, catalog E2E. Жоден старий case не видалено; disabled/CUSTOM-only очікування замінено сильними перевірками потрібних дій/ownership, решта assertions збережена.

Реальні Chromium E2E:

1. Guest catalog → login return → CLIENT PENDING → MASTER accepts/starts/completes → CLIENT COMPLETED; наступне редагування Service не змінює стару ціну/назву/категорію Order.
2. MASTER DECLINED → terminal/read-only та збережена CLIENT історія з null price.
3. CLIENT CANCELLED через чинний діалог → запис/history лишаються, повторний DELETE → 409.
4. Stale form після hiding → POST 409/preview 404 без Order; старий URL після login теж не дає оформлення.

`test:e2e` послідовно запускає п’ять обов’язкових груп 15/4/3/3/4 з новими серверами й окремими JSON results (додано e2e-standard-results.json). Production rate limits/JWT/CORS не послаблені. Helper login очікує HTTP 200 і кінцевий маршрут; часових sleep/force click/retry для приховування збоїв немає. Screenshots/traces/video з токенами не створюються.

Нові fixtures очищаються тільки за власними synthetic IDs. Старі selected-offer histories інших suites лишаються в *_test через deletion guards. Немає припущення, що БД містить тільки seed-рядки. П’ять моделей, DBML, усі три SQL-міграції, auth/JWT/CORS/rate limits, service CRUD/catalog та transition() незмінні. Схема нових колонок/ролей не потребує.

## Змінені файли

- Backend: src/orders/service.ts; src/orders/router.ts; src/orders/dto.ts; src/orders/standard-snapshot.ts.
- Frontend: frontend/src/App.tsx; frontend/src/catalog.tsx; frontend/src/orders.tsx; frontend/src/master-orders.tsx; frontend/src/standard-order.tsx; frontend/src/standard-return.ts; frontend/src/styles.css.
- Тести: tests/standard.integration.test.mjs; tests/offers.integration.test.mjs; frontend/src/standard.test.tsx; frontend/src/lifecycle.test.tsx; frontend/src/services.test.tsx; e2e/standard.spec.ts; e2e/catalog.spec.ts.
- Runner: frontend/vite.config.ts; package.json; playwright.config.mjs.
- Документація: README.md; FIXIT_MVP_SPEC.md; docs/US_04_STANDARD.md; docs/WINDOWS_STANDARD_QA.md.

## Межі та QA

[Окремий Windows 11 checklist і PostgreSQL status_history](WINDOWS_STANDARD_QA.md). Windows/Postman execution та локальні screenshots тут не заявляються.

FIX-17, draft persistence, server idempotency/exactly-once, realtime, повний timeline, scheduling/slot inventory, chat/payments/ratings/notifications/ADMIN UI поза цим PR. Без expectedSnapshot direct API caller свідомо приймає поточний DB стан. Для public direct URLs у production static hosting потрібен SPA fallback; Vite F5 збережено й перевірено регресійними E2E. US-08 тепер має CUSTOM та STANDARD workflow; Jira status автоматично не змінюється й merge не виконується.
