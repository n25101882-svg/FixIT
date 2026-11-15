# US-09 / FIX-9 — Order Details & History

База: develop після merged PR #9, `79861dd45c45054683dc2b8148965d902621961f`.
Гілка: `feature/us-09-order-details`. Фактична Cloud перевірка: 15.11.2026, Linux.

## Архітектура та Code Review summary

- Два захищені GET, без нових mutation APIs чи дублювання state machine. CLIENT ownership та MASTER profile ownership/current role включені в початковий scoped findFirst. Немає unrestricted read із наступним порівнянням private fields. Foreign і missing — той самий 404.
- Деталі розширюють publicOrder()/masterOrder(). Raw audit history нікому не повертається через нові detail routes; MASTER також не отримує clientId. Public assignedMaster використовує чинний publicMasterSelect, не email/User.id/password.
- Safe timeline нормалізує лише реальні збережені events. Timestamp має бути валідним ISO із timezone; completedAt використовує ту саму перевірку. Legacy observation не підміняє реальний час завершення; SQL/history не переписуються.
- Спільна read-only React-сторінка, посилання зі списків, стани помилок/refresh, abort + request generation guards, remount за route/account. Після 403/404/loading старих приватних карток немає. Після 401 — чинний logout.
- Для повторного login allowlist розширений тільки двома UUID details paths. In-memory JWT, CORS/rate limits і бізнес-команди не змінено. Старі API contracts збережено; invalid/ambiguous completion timestamps більше не інтерпретуються як дати через permissive Date parsing.

## API-контракт

| Маршрут | Хто | Scope | 200 |
| --- | --- | --- | --- |
| GET `/api/v1/orders/:id` | CLIENT | id + clientId із JWT + current CLIENT role | `{order}` із CLIENT fields та safe timeline |
| GET `/api/v1/master/orders/:id` | MASTER | id + masterProfile.userId із JWT + current MASTER role | `{order}` із MASTER fields та safe timeline |

UUID валідований Zod; query-параметри не підтримуються. Body/URL не задають identity чи ownership. Missing/invalid/expired/wrong-key JWT або видалений account → 401; CLIENT на MASTER API, MASTER на CLIENT API, ADMIN → 403. Foreign/missing order, MASTER без призначення/профілю → однаковий 404. Некоректний UUID/query → 400. Cache-Control no-store з чинного app middleware.

STANDARD PENDING доступне лише його CLIENT і MASTER. CUSTOM до вибору виконавця доступне у private details тільки власнику CLIENT; навіть MASTER із пропозицією отримує 404. Open feed зберігає попередній обмежений DTO. Після призначення MASTER може читати свою заявку в тому числі після завершення або скасування.

Спільні fields: id, type, title, description, city, category, status, budget, priceAtOrder, serviceId, createdAt, updatedAt, completedAt; також assignedMaster (чинні public id/name/city/category/description або null), timeline. CLIENT зберігає власні clientId/masterProfileId із publicOrder; MASTER не отримує їх і не отримує приватні CLIENT fields. Гроші — exact fixed-two strings або null. STANDARD null price — «Ціна за домовленістю»; CUSTOM null budget — «Бюджет не вказано».

Title/category/city/price — historical Order snapshot, не повторний lookup поточної Service ціни/назви. AssignedMaster — поточний дозволений public profile, що може змінити ім’я/місто незалежно від Order snapshot. Public price/catalog updates не переписують Order або timeline.

Приклад безпечної події:

```json
{"status":"ACCEPTED","at":"2026-11-15T10:01:00.000Z","source":"database"}
```

Це ілюстрація форми, не підроблений результат БД. Весь `{order}` віддає existing fields плюс цей окремий timeline; raw statusHistory в detail немає. Чинні GET списків, POST/DELETE/PATCH, responses/selection endpoints збережені. Власні CUSTOM пропозиції відкриваються через посилання назад до наявного CLIENT списку та його «Переглянути пропозиції».

## Safe timeline

Джерело — реальний orders.status_history JSONB. Allowlist: status із OrderStatus, at як нормалізований UTC ISO або null, optional source лише database/legacy_migration. actorUserId, довільні actorRole/source, email та інші audit/legacy поля відкидаються. Роль автора не виводиться: поточна роль User не доводить його роль на момент історичної події.

Відомі датовані події йдуть хронологічно; однакові timestamps зберігають порядок масиву. Undated entries ідуть після них у вихідному порядку, UI явно каже «Час події не збережено». Некоректні/невідомі статуси або не-objects пропускаються; порожній результат → «Історію статусів не збережено». Відсутні переходи/час не відновлюються з createdAt/updatedAt/legacyCreatedAt.

Legacy source=legacy_migration показується як **історичний стан, зафіксований під час міграції**, а не як доказ часу переходу. completedAt — тільки валідна ISO COMPLETED подія source=database, і лише коли поточний статус COMPLETED; інакше null та явне повідомлення про невідомий час. SQL triggers/історія незмінні. Safe DTO normalization неповних/legacy JSON тестується без будь-якого UPDATE історії або вимкнення triggers.

## React та стани

- CLIENT `/orders/:id`, MASTER `/master/orders/:id`; «Переглянути деталі» на кожній власній картці. Списки показують назву/тип/дату/статус, MASTER також отримав visible created date.
- Заголовок, snapshot, description, city/category, ціна/бюджет, виконавець, created/updated/completed та OL timeline. Світлі існуючі profile-card/зелена палітра; UUID переноситься на вузькому екрані.
- Loading/404/Forbidden/network/5xx/retry/refresh. При кожному GET попередня картка прибирається; 403/404 не лишають приватного кешу. Повторний GET отримує поточний стан із сервера.
- AbortController + generation guard; route/account key прибирає старий resource ще до нового effect. Late success/error/401 зі старого route не змінює новий екран і не викликає logout.
- 401 завершує сесію. Після F5 потрібен login (FIX-17); allowlist відновлює тільки /orders/UUID, /master/orders/UUID або чинний STANDARD booking UUID path. Query/hash/external/двозначні paths не приймаються. Немає token storage/localStorage.
- Деталі read-only; «До моїх замовлень» → /orders для CLIENT, /dashboard з assignments для MASTER. Скасування, пропозиції/вибір, accept/decline/start/complete лишаються у чинних списках. Нова state machine не створена.

## Фактичні автоматизовані перевірки

Node 24.22.1/npm 11.9.0, PostgreSQL 18.6, Prisma 7.10.1, Vitest/coverage-v8 5.1.0. Нова loopback **fixit_details_test**, окрема від fixit_dev; приватний helper /workspace/.fixit-dev/details-env.sh поза Git. Усі 3 чинні міграції застосовані з нуля, повторний status підтвердив up to date. Ніякого reset/db push, production credentials або змін домашньої БД.

| Команда | Фактичний результат |
| --- | --- |
| npm run typecheck | PASS |
| npm test | **516/516**, 13 suites (428 попередніх + 88 нових) |
| npm run frontend:test | **255/255**, 9 files (205 попередніх + 50 нових) |
| npm run frontend:build | PASS, TypeScript/Vite production build |
| npm run frontend:coverage | **255/255**, усі 9 per-file gates 71% пройдені |
| npm run test:e2e | **33/33** (29 попередніх + 4 нових) |
| npm run db:validate | PASS, Prisma schema valid |
| npm run er:validate | PASS, 5 tables / 7 FK |
| npm run db:status / db:check | 3 migrations up to date, connection/schema OK |

Жоден старий test/assertion не видалено й не послаблено. Integration перевіряє scoped queries, чужих CLIENT/MASTER, unassigned/open/response-only доступ, ADMIN/legacy no-profile, JWT, UUID/query, обидва типи/всі законні стани, terminal persistence, real trigger dates/order, повторний GET, історичні snapshot після Service/Profile edit, null/Decimal і safe DTO. Legacy/incomplete timestamp cases — DTO normalization, без mutation історії.

Frontend: mock HTTP/окремі fixtures, transitions list→details→back, STANDARD/CUSTOM, timeline/dates/terminal states, incomplete history, 401/403/404/5xx/network, retry/refresh/cache clear, request abort/stale success/late errors та allowlisted re-login. Дані кожного нового backend/browser cohort мають власні synthetic IDs; жодного пошуку всіх користувачів за доменом чи припущення про seed-only DB. Selected-response histories залишаються лише в *_test через наявні guards.

Browser Chromium, реальний React → JWT API → PostgreSQL → React:

1. CUSTOM створюється CLIENT через форму, MASTER пропонує, CLIENT обирає, MASTER починає/завершує. Обидва відкривають details із DB timestamps. Foreign MASTER → API/UI 404; CLIENT F5 → login return → той самий timeline, повторний GET не змінює history.
2. STANDARD через чинні API підготовлено до COMPLETED, CLIENT та призначений MASTER перевіряють details/price/timeline через direct URL та login. Повний browser STANDARD creation/lifecycle також лишився у попередніх 4 @standard тестах.
3. CLIENT скасовує CUSTOM у чинному діалозі, читає CANCELLED details; unassigned MASTER → 404, Order не видалений.
4. MASTER відхиляє STANDARD у кабінеті; обидва читають DECLINED details без mutation actions, Order збережений.

Root test:e2e тепер має **шість обов’язкових груп 15/4/3/3/4/4**, остання @details, із свіжими server processes. Жодних skip/послаблень auth/rate limits/CORS. Окремий ignored test-results/e2e-details-results.json; traces/video/screenshots із секретами не записуються.

Coverage вибраних повних frontend-модулів (не backend і не весь проєкт):

| Модуль | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| order-details.tsx | 100% | 97.05% | 100% | 100% |
| order-return.ts | 100% | 100% | 100% | 100% |
| orders.tsx | 96.85% | 89.04% | 100% | 100% |
| master-orders.tsx | 96.24% | 91.66% | 100% | 100% |
| standard-order.tsx | 97.58% | 89.43% | 100% | 100% |
| standard-return.ts | 100% | 100% | 100% | 100% |
| catalog.tsx | 91.22% | 87.87% | 90.90% | 93.54% |
| master-services.tsx | 97.97% | 86.79% | 100% | 100% |
| CancelOrderDialog.tsx | 96.77% | 95.65% | 100% | 100% |
| Разом 9 модулів | 96.87% | 90.22% | 98.63% | 99.48% |

Coverage include розширено, пороги не знижено, складні гілки не виключено. HTML/JSON coverage, build output, test results, .env та secrets ігноруються Git.

## Acceptance Criteria US-09

| AC | Реалізація / доказ |
| --- | --- |
| 1. CLIENT тільки свої, MASTER тільки призначені/вхідні STANDARD | Чинні списки + scoped new GET, foreign/unassigned/response-only tests |
| 2. Назва/тип/дата/статус і деталі | Картки обох ролей, links, read-only details, frontend/E2E |
| 3. Скасування OPEN/PENDING/ACCEPTED, заборона після початку | Незмінний transition()/DELETE; збережена регресія + CANCELLED details |
| 4. Terminal records/history лишаються | COMPLETED/CANCELLED/DECLINED read tests, DB row/history comparisons, E2E |
| 5. Серверні роль/ownership | JWT + current-role middleware, scoped where, 400/401/403/404/DTO tests |
| 6. Loading/Empty/error зрозумілі | Старі list cases без змін; details 404/Forbidden/network/retry/stale request tests |

## Windows 11 QA — наявні TestClient, TestMaster1, TestMaster2

**Це інструкція, не виконаний Windows тест.** Локальні CUSTOM «Протікає кран» і STANDARD «тест2» зі статусом COMPLETED не змінювати й не видаляти. Їхня наявність у Cloud не припускалася. Ніякі npm tests/seed/migrations нижче не запускати проти БД цих записів або fixit_dev.

Для read-only ручної перевірки використайте свій вже налаштований локальний backend/frontend з цією гілкою, приватними environment bindings і наявними synthetic accounts. Не копіюйте їхні credentials у Git/звіт. За потреби у двох терміналах: npm run dev та npm run frontend:dev (API 127.0.0.1:3000, UI 127.0.0.1:5173).

- [ ] TestClient → /orders. Знайти «Протікає кран» і «тест2»; перевірити тип, дату, COMPLETED, відсутність скасування.
- [ ] «Переглянути деталі» → /orders/UUID; Network GET /api/v1/orders/UUID → 200. Є snapshot, budget/price як збережено, MASTER name, dates та реальні доступні events. Не вимагати вигадану повну історію від legacy rows.
- [ ] «Оновити деталі» повторює тільки GET, записи не змінюються. «До моїх замовлень» повертає список. Для CUSTOM посилання на пропозиції веде у наявний список із «Переглянути пропозиції».
- [ ] Інший browser profile: TestMaster1 → /dashboard, відкрити лише реально призначене йому замовлення. GET /api/v1/master/orders/UUID → 200. Немає CLIENT email/clientId/raw actorUserId/statusHistory у response.
- [ ] TestMaster2 відкриває direct URL чужого замовлення → login за потреби, потім 404 без картки/опису/кешу. Якщо виконавцем конкретного Order є TestMaster2, поміняйте ролі цих двох тестових акаунтів у цьому кроці.
- [ ] CLIENT на MASTER API або MASTER на CLIENT API → 403; без JWT → 401; невідомий UUID → 404; invalid UUID або ?clientId=... → 400. Використовуйте лише локальний тестовий Postman profile, не публікуйте Authorization.
- [ ] На власній detail URL F5 → login із safe returnTo → та сама сторінка/історія після входу. Це очікуваний FIX-17, а не збережена сесія.
- [ ] Для перевірки refresh відкрийте інше дозволене synthetic nonterminal замовлення **лише у *_test**, змініть статус через наявний кабінет MASTER, натисніть «Оновити деталі» у CLIENT — новий стан/timeline без F5.
- [ ] Нові CANCELLED/DECLINED fixtures створюйте/скасовуйте/відхиляйте тільки в окремій *_test БД через чинні UI flows. У details немає нових mutation buttons; terminal rows лишаються у списку.
- [ ] Зробіть справжні скріншоти CLIENT/MASTER details і Network GET 200/404, якщо потрібні для звіту, приховавши JWT/email/паролі/.env. Скриншоти тут не створювалися.

### SQL для звірки real status_history (тільки SELECT)

У власному локальному psql замініть placeholder на UUID відповідного **synthetic** Order; не публікуйте connection strings. Вивід навмисно не містить raw actor IDs:

```sql
SELECT id, type, status, title, city, category, price_at_order, budget,
       created_at, updated_at
FROM orders WHERE id = '<synthetic-order-uuid>';

SELECT e.ordinality AS event_no, e.value->>'status' AS status,
       e.value->>'at' AS at, e.value->>'source' AS source
FROM orders o
CROSS JOIN LATERAL jsonb_array_elements(o.status_history)
  WITH ORDINALITY AS e(value, ordinality)
WHERE o.id = '<synthetic-order-uuid>'
ORDER BY e.ordinality;
```

Звірте timeline із реальними events; API нормалізує timezone у UTC ISO/ms, UI показує browser-local uk-UA час. STANDARD: PENDING → ACCEPTED → IN_PROGRESS → COMPLETED або PENDING → DECLINED; CUSTOM: OPEN → ACCEPTED → IN_PROGRESS → COMPLETED або OPEN → CANCELLED. Законне скасування PENDING/ACCEPTED теж зберігається. source=legacy_migration — лише observation, не доказ actual completion time; невідомі dates лишаються невідомими.

### Автоматизована локальна QA — тільки окрема *_test

Node 24/npm 11, PostgreSQL 18, роль з мінімальними правами та окрема loopback fixit_details_test. Не перевизначайте пароль/наявну роль автоматично. DATABASE_URL і TEST_DATABASE_URL у приватному .env мають вказувати на цю саму тестову БД, JWT_SECRET — власний випадковий, не VITE_*. Existing local examples вище не використовуються.

```powershell
git fetch origin
git switch feature/us-09-order-details
if (!(Test-Path .env)) { Copy-Item .env.example .env }
# Налаштуйте приватний .env на окрему loopback *_test.
npm ci
npm run db:generate
npm run build
node --input-type=module -e "import {requireLocalTestDatabase} from './dist/config.js'; requireLocalTestDatabase(process.env.TEST_DATABASE_URL); requireLocalTestDatabase(process.env.DATABASE_URL); if(process.env.DATABASE_URL!==process.env.TEST_DATABASE_URL) throw Error('Use the same isolated test DB'); console.log('Loopback test bindings OK');"
# Лише після успішної перевірки bindings:
npm run db:migrate
npm run db:status
npm run db:check
npm run typecheck
npm test
npm run frontend:test
npm run frontend:build
npm run frontend:coverage
npm exec playwright install chromium
npm run test:e2e
npm run db:validate
npm run er:validate
```

На Windows не задавайте Linux PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. E2E запускає окремі 4100/5174 servers, own random JWT secret; test-results/coverage не комітити. На цій Cloud машині приватний source /workspace/.fixit-dev/details-env.sh налаштовує дозволену *_test; відтворювані npm-команди ті самі.

## Змінені файли

- Backend: src/orders/router.ts; src/orders/dto.ts.
- Frontend: frontend/src/order-details.tsx; frontend/src/order-return.ts; frontend/src/App.tsx; frontend/src/orders.tsx; frontend/src/master-orders.tsx; frontend/src/styles.css.
- Тести: tests/order-details.integration.test.mjs; frontend/src/order-details.test.tsx; e2e/order-details.spec.ts.
- Runner: frontend/vite.config.ts; package.json; playwright.config.mjs.
- Документація: README.md; FIXIT_MVP_SPEC.md; docs/US_09_ORDER_DETAILS.md.

## Обмеження

FIX-17 не виправлений: F5 губить in-memory JWT; збережений лише безпечний URL через новий login. Деталі read-only; дії/пропозиції у чинних списках. Realtime немає — актуалізація явним GET. Legacy timeline може бути неповним; автора/час не вигадуємо. Server idempotency/exactly-once, chat, payments, notifications, ratings та нові ролі поза scope. Production SPA hosting потребує чинного fallback для direct URLs. Windows QA та screenshots не заявляються як виконані. Jira status не змінюється автоматично.

П’ять таблиць, Prisma 7.10.1 schema/DBML, 3 migration files, CHECK/FK/triggers та src/orders/service.ts цілком збережені. Нового backend command шару немає. fixit_dev/production/home network не використовувалися. Жодного automatic merge.
