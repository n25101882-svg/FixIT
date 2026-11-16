# FixIT — Hybrid MVP, послуги, замовлення та історія

Node.js 24 / npm 11, Express + TypeScript, PostgreSQL 18, Prisma 7.10.1; React + Vite + TypeScript. Поточна база FIX-17 — develop після PR #11 (`2887f5417c88914d07490f8debd9959c19862628`). Збережені Hybrid database, CUSTOM/STANDARD orders, послуги/каталог, пропозиції/вибір виконавця, виконання робіт і приватний timeline. Додано безпечне відновлення авторизації після F5 та single-origin production hosting.

П’ять бізнес-таблиць: users, master_profiles, services, orders, order_responses; одна технічна auth_sessions. Три застосовані SQL-міграції з develop збережені без змін, четверта `20261116090000_add_auth_sessions` додає лише сесії. Грошові поля — decimal(10,2), зокрема nullable Service.priceEstimate (`price_estimate`); Float не використовується. [Специфікація](FIXIT_MVP_SPEC.md), [фізична DBML](docs/er-diagram.dbml), [звіт №6](docs/PRACTICAL_6.md), [звіт №7](docs/PRACTICAL_7.md), [звіт №9](docs/PRACTICAL_9.md). Нижче історичні результати попередніх PR позначають стан відповідного етапу.

## Що працює

- POST `/api/v1/auth/register`: CLIENT → тільки User; MASTER → одна транзакція User + MasterProfile + перша Service. Валідація до запису, помилка будь-якого INSERT/commit → rollback, success лише після commit. Публічна ADMIN-реєстрація і mass assignment заборонені.
- POST `/api/v1/auth/login`: salted scrypt password verification, 15-хвилинний HS256 JWT у пам’яті React та HttpOnly refresh-cookie; secret тільки з environment.
- POST `/api/v1/auth/refresh`, `/api/v1/auth/logout`: атомарна ротація/відкликання PostgreSQL refresh-сесії, CSRF Origin/header, 7 днів absolute / 24 години idle; refresh-токен ніколи не повертається в JSON.
- GET `/api/v1/users/me`: JWT-захист, лише id/email/name/role; missing/invalid/expired → 401. Точні CORS origins, JSON size limit і auth rate limiting збережені.
- React `/register`, `/login`, protected `/dashboard`, повідомлення про помилки і logout. MASTER-поля показуються лише для MASTER; CLIENT їх не надсилає. Bootstrap відновлює JWT після F5 без передчасного redirect; токенів у Web Storage немає.
- Захищені CLIENT GET/POST `/api/v1/orders`, DELETE `/api/v1/orders/:id`: власний список, CUSTOM OPEN, логічне CANCELLED через наявний сервіс; скасовані записи/історія збережені. React `/orders` відкривається з кабінету, оновлює список без reload і показує Loading/Empty/Error/Success.
- US-06/US-07: MASTER `/master/orders` показує OPEN CUSTOM за профільним містом/категорією і приймає текстову пропозицію; CLIENT `/orders` читає свої пропозиції й обирає одного виконавця. Кабінет MASTER показує призначені CUSTOM та поточні статуси, включно з кінцевими. [API, перевірки та Windows QA](docs/US_06_07.md).
- US-08 (CUSTOM, FIX-8) / частина US-09 (FIX-9): призначений MASTER починає та завершує роботу з кабінету через PATCH `/api/v1/master/orders/:id/status`. CLIENT після «Оновити» бачить «У роботі» / «Завершена»; скасування після початку заборонене сервером. Дата завершення — з реальної DB-події, без нової колонки. [Звіт і Windows QA](docs/US_08.md).
- US-09 / FIX-9: CLIENT `/orders/:id`, MASTER `/master/orders/:id`, посилання з власних карток. Відповідні GET `/api/v1/orders/:id` і `/api/v1/master/orders/:id` читають тільки дозволений ресурс; foreign/missing — однаковий 404. Timeline не містить raw actor IDs, legacy/missing times не вигадуються. Direct URL після login відновлюється через allowlist; JWT лишається in-memory. [Архітектура, перевірки, Windows QA для TestClient/TestMaster1/TestMaster2](docs/US_09_ORDER_DETAILS.md).
- `/health`, `/health/ready` та чинна транзакційна логіка `src/orders/service.ts` збережені. Reviews, ADMIN UI, платежі та чат не додаються.

## FIX-17 — результати PR #12

У Codex Cloud фактично пройшли **651 backend / 287 frontend / 43 Chromium E2E** (baseline 587/255/33 збережено), `npm ci --include=dev`, `release:verify` і clean/upgrade `test:migrations`. Coverage 12 модулів: **97.02 / 90.08 / 97.94 / 99.43%** (Statements / Branches / Functions / Lines), per-file gates 71% не знижено. Typecheck, production build, Prisma/ER/DB та локальний deployment validator — PASS.

Production — один Node Web Service з React/API і окрема PG18. Refresh-cookie `__Host-`, Secure/HttpOnly/Lax/Path=/ без Domain; атомарна ротація й replay detection. Конкурентний старий verifier отримує 409 без credentials, пізній replay відкликає лише свою сесію. Access JWT лишається stateless і може діяти до кінця 15-хвилинного TTL після Logout. Втрачена відповідь ротації може вимагати повторного входу; offline Logout зберігає лише не-секретний cookie-маркер наміру до серверного підтвердження.

[Архітектура, точні перевірки, SQL-обмеження й security review](docs/FIX_17_REFRESH_SESSIONS.md) · [майбутній Windows QA](docs/WINDOWS_SESSION_QA.md). Власнику не потрібно ручне QA для створення PR: усі автоматизовані перевірки виконані в Cloud на нових *_test БД. Windows і реальний Render — NOT RUN; live Render schema — BLOCKED proxy CONNECT403. Наявні fixit_dev/fixit_test/fixit_shadow не використовувалися й не змінювалися. Merge/deployment/Jira/release не виконуються.

## Windows / PowerShell

Для підготовки релізу після PR #10 див. [Render deployment/rollback](docs/DEPLOYMENT_RENDER.md), [release checklist та ST1–ST5](docs/RELEASE_CHECKLIST.md), [фактичні результати й security findings](docs/RELEASE_PREPARATION.md), [порожній шаблон практичної №11](docs/PRACTICAL_11_RESULTS_TEMPLATE.md).

`npm run release:verify` відтворює локальні перевірки лише на явно налаштованій окремій loopback *_test БД, відмовляється від fixit_test/fixit_shadow та не запускає cloud deployment. `npm run deploy:validate` перевіряє локальні інваріанти render.yaml, а не live Render schema. Blueprint має один free Node service і free PG18, autodeploy off, private DB binding, generated JWT secret, SERVE_FRONTEND=1 та VITE_API_URL=/api/v1. Dashboard Blueprint auto-sync також має бути вимкнений оператором; це тут не перевірялося. Не застосовуйте Blueprint без окремого схвалення — initial Apply може одразу почати deploy.

Feature Freeze/release/v1.0.0 очікують code/security review FIX-17, решту QA й рішення щодо idempotency-ризику. Архітектурне рішення FIX-17 надав власник, реалізацію перевірено в Cloud. Production-only npm audit: 0; full tree: 19 dev advisories, які лишаються на хості через Prisma CLI-at-start. Залежності/lockfile, три старі міграції та бізнес-модулі незмінні.

Потрібні Git, Node 24/npm 11, PostgreSQL 18 і psql у PATH. Використовуйте окремі локальні *_test БД; fixit_dev/production не використовувати для тестів/seed. Жодного Docker/WSL/домашньої мережі для Cloud не потрібно.

Через власного локального адміністратора (`psql -h 127.0.0.1 -U postgres -d postgres`) створіть **лише відсутні** роль і тестові БД. Якщо роль/БД уже існують, не видаляйте й не перевизначайте пароль автоматично.

```sql
-- Тільки якщо роль відсутня:
CREATE ROLE fixit_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password fixit_test
CREATE DATABASE fixit_sessions_windows_test OWNER fixit_test;
-- Дві окремі НОВІ ПОРОЖНІ *_test БД тільки для test:migrations:
CREATE DATABASE fixit_sessions_windows_clean_test OWNER fixit_test;
CREATE DATABASE fixit_sessions_windows_upgrade_test OWNER fixit_test;
```

```powershell
Copy-Item .env.example .env
```

У приватному .env задайте власний percent-encoded пароль локальної ролі, DATABASE_URL/TEST_DATABASE_URL для нової fixit_sessions_windows_test. Схема — public. Для migrate deploy shadow не потрібна; існуючу fixit_shadow не використовувати. Для test:migrations задайте CLEAN_DATABASE_URL і UPGRADE_DATABASE_URL двох порожніх БД вище, відмінних від головної. Не публікуйте .env, паролі чи реальні URL.

Згенеруйте випадковий JWT_SECRET локально і перенесіть значення **тільки** у приватний .env:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Не знімайте цей вивід для звіту. JWT_SECRET має бути мінімум 32 bytes, JWT_TTL_SECONDS типово 900. Після налаштування:

```powershell
npm ci --include=dev
npm run db:generate
npm run db:validate
npm run db:migrate
npm run db:status
npm run db:migrate
npm run db:seed
npm run db:seed
npm run db:check
npm run typecheck
npm run er:validate
npm test
npm run build
npm run frontend:build
npm run frontend:test
npm run frontend:coverage
npm run test:migrations
```

Prisma CLI читає .env, тому Windows PowerShell не потребує `export` для цих команд. Jest/Playwright читають TEST_DATABASE_URL через конфігурацію проєкту з .env. Migration verifier відмовиться на непорожніх clean/upgrade БД; для повторного прогону створіть нову пару порожніх *_test БД та змініть приватні bindings. Бази після перевірки збережені, reset/drop не виконується.

У першому терміналі:

```powershell
npm run dev
# Або після npm run build: npm start
```

У другому, з кореня репозиторію:

```powershell
npm run frontend:dev
```

Backend: **http://127.0.0.1:3000**, frontend: **http://127.0.0.1:5173**. Для cookie використовуйте один hostname з обох боків, не змішуйте localhost і 127.0.0.1. VITE_API_URL у Vite dev типово http://127.0.0.1:3000/api/v1; root CORS_ORIGINS містить точні loopback origins. SERVE_FRONTEND=0 для dev, production single-origin build — відносний /api/v1. Optional frontend/.env створюйте з frontend/.env.example; жодних JWT_SECRET/DATABASE_URL у VITE_*.

Для Playwright використайте Chromium поточного runner:

```powershell
npm exec playwright install chromium
npm run test:e2e
```

На Windows не задавайте Linux PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. E2E запускає власні сервери на **4100/5174** і production single-origin **4200** із випадковим environment secret. Використовується явний локальний TEST_DATABASE_URL; існуючі сервери не перевикористовуються. Trace/video/screenshots вимкнені, test-results і playwright-report ігноруються Git. Windows/Postman QA тут **документована, не виконана**.

## Codex Cloud

Cloud має власний локальний PostgreSQL кластер, незалежний від домашнього Windows/WSL. У поточній підготовленій машині:

```bash
cd /workspace/FixIT
bash /workspace/.fixit-dev/bin/pg.sh start
source /workspace/.fixit-dev/sessions-env.sh
unset PRISMA_SCHEMA_ENGINE_BINARY PRISMA_MIGRATION_ENGINE_BINARY
npm ci --include=dev
npm run release:verify
# test:migrations already passed on this task's clean/upgrade pair.
# Provision a NEW EMPTY pair and update private bindings before repeating it.
```

sessions-env.sh — приватний helper цієї машини поза Git; задає нову fixit_sessions_final_test на 127.0.0.1:55432 й доступний Chromium. На іншій машині налаштуйте власні дозволені нові TEST/DATABASE bindings та Chromium. У helper немає production-секретів. Для ручного dev додатково задайте JWT_SECRET через захищене environment або приватний .env; E2E генерує власний випадковий secret.

Prisma працює зі штатним engine, TLS/checksum verification не вимикаються, Rust compilation/override не потрібні. URL задається у prisma.config.ts. Для migrate dev потрібна окрема shadow database. Використовуйте migrate deploy, не db push/reset; для робочих даних потрібні окрема перевірка/backup. Backend startup не виконує seed/міграцій, перевіряє SQL-з’єднання перед listen; SIGINT/SIGTERM закриває пул.

## Реєстрація та QA

Спільні поля: name, email, password, **passwordConfirmation**, role CLIENT/MASTER (типово CLIENT). MASTER додатково: city, category (TECH_REPAIR/PLUMBING/ELECTRICAL/OTHER), profileDescription, serviceTitle, serviceDescription; optional priceEstimate, наприклад рядок `"250.50"`. Описи окремі, profile/first Service отримують одну category; ніяких placeholder. CLIENT MASTER-полів не надсилає. Межі/повні JSON/Postman приклади — у звіті №7.

Для практичної №9 у Cloud фактично пройшли **198 backend тестів** (попередні **145** + **53 Orders API**), **48 frontend тестів** (усі попередні **27** + **21 review regression**), **15 browser E2E** (усі попередні **10** + **5 review regression**). Перевірені rollback реальної помилки першої Service, duplicate/race email, валідація до запису, обидві ролі, JWT/CORS/rate limits, nullable exact prices і три міграції clean/legacy upgrade. Повний список команд і результатів — [PRACTICAL_9.md](docs/PRACTICAL_9.md).

Попередні Auth/browser тести створюють випадково іменовані синтетичні акаунти та видаляють тільки свої Service → Profile → User, не обходячи RESTRICT FK. Нові US-06/US-07 тести зберігають synthetic cohort і вибрані OrderResponse/історію в ізольованій *_test БД, оскільки SQL забороняє видаляти вибрану пропозицію. Hybrid concurrency-тест навмисно лишає одну власну синтетичну заявку/пропозиції на кожний прогін тільки в ізольованій *_test БД; інші мутації відкочуються. Seed fixtures: 5 users / 2 profiles / 3 services / 3 orders / 2 responses; global counts після concurrency можуть бути більшими. Seed-акаунти не мають відомого спільного пароля; для login створіть свій синтетичний account.

Для №7 потрібні три **справжні** screenshots: Postman POST login 200 із замаскованим JWT, браузер /dashboard із synthetic email, backend terminal із database connected/listen. Покрокова інструкція — у [звіті №7](docs/PRACTICAL_7.md). Звітні screenshots, Windows чи Postman execution тут не вигадуються.

Для №9 у браузері CLIENT відкрийте /dashboard → «Мої заявки», створіть CUSTOM із title/description/city/category і optional budget (точний рядок). Скасування — тільки до початку робіт, запис залишається у списку зі статусом «Скасована». Зміни з інших сесій видно після «Оновити»; GET без пагінації/query-фільтрів. Windows QA та три реальні докази (/orders, Network HTTP 200/201, PostgreSQL SELECT) описані у звіті №9; скріншоти/Windows execution тут не вигадуються.

PR #4 review / FIX-18: перед DELETE є клавіатурний діалог з «Ні», Escape і закриттям без запиту; після 409 виконується автоматичний GET зі збереженням повідомлення про конфлікт. Помилка повторного GET має власний retry, застаріле скасування заблоковане. Форма лишається доступною під час loading/мережевих/5xx помилок історії; 401 завершує сесію, 403 блокує CLIENT-функції. FIX-17 (F5/session) не змінений. Фактичні перевірки від 15.11.2026 й межі — у review-розділі звіту №9.

## Практична №10 — Unit Code Coverage

Vitest і @vitest/coverage-v8 мають сумісну exact-версію **5.1.0**. З кореня репозиторію: `npm ci`, потім **`npm run frontend:coverage`**. Базові модулі №10 — повні orders.tsx і CancelOrderDialog.tsx; US-02/03 додають catalog.tsx і master-services.tsx; STANDARD також охоплює standard-order.tsx, standard-return.ts і master-orders.tsx; US-09 додає order-details.tsx і order-return.ts. Per-file gate — 71% для Statements/Branches/Functions/Lines. HTML — frontend/coverage/index.html (PowerShell: `Start-Process .\frontend\coverage\index.html`), JSON і assets поряд; generated coverage ігнорується Git. Unit coverage не потребує PostgreSQL/JWT_SECRET.

У перевірці №10: **198 backend / 60 frontend / 15 E2E**, старі 48 frontend-сценаріїв збережені, додано 12 ізольованих AAA cases. orders.tsx: **96.49 / 88.69 / 100 / 100%**, CancelOrderDialog.tsx: **96.77 / 95.65 / 100 / 100%** у порядку Statements / Branches / Functions / Lines. FIX-18 регресійно підтверджено; FIX-17 не виправлявся. [Звіт №10, точні counts і Windows QA](docs/PRACTICAL_10.md). Попередні навчальні звіти не змінені.

## US-06/US-07 — пропозиції майстрів

Гілка `feature/us-06-07-master-offers` від develop після PR #5. Власник CLIENT відкриває «Переглянути пропозиції» у /orders і обирає майстра. MASTER переходить із кабінету до «Заявки для майстра», надсилає одну текстову пропозицію; призначену заявку бачить у /dashboard. «Оновити» перечитує стан з API; realtime/pagination не додаються.

`npm run test:e2e` послідовно запускає попередню регресію, `@offers`, `@lifecycle`, `@catalog`, `@standard` та `@details` сценарії з окремими процесами серверів. Це ізолює synthetic auth traffic і лічильник штатного rate limiter, без зміни auth-конфігурації. Усі шість запусків обов’язкові, JSON-звіти окремі в ігнорованому test-results/. Для US-06/07 застосовувався приватний offers-env.sh, БД fixit_offers_test; поточна US-09 перевірка — details-env.sh / fixit_details_test поза Git. На Windows налаштуйте свою локальну *_test БД за інструкцією вище.

Повний звіт із фактичними перевірками, обмеженнями й командами — [docs/US_06_07.md](docs/US_06_07.md). Звіти попередніх практичних не переписуються.

## US-08 — виконання CUSTOM-замовлення

База develop після PR #6 (`0467d996`), гілка `feature/us-08-order-lifecycle`. У MASTER кабінеті: «Розпочати роботу» для ACCEPTED, «Завершити роботу» для IN_PROGRESS, завершений стан/відома дата без дій для COMPLETED. PATCH делегує незмінному `transition()`, DB triggers ведуть історію. На 409 або втрату відповіді клієнт перечитує призначення; після невдалого GET повторна дія заблокована до синхронізації. 401 завершує сесію, 403 блокує повторну мутацію картки.

Фактично: **295 backend / 121 frontend / 22 browser E2E**, попередні 244/99/19 збережені. Typecheck, frontend build та coverage gate пройшли. Cloud перевірка використовує окрему нову `fixit_lifecycle_test`, helper `source /workspace/.fixit-dev/lifecycle-env.sh` поза Git. Схема, DBML, три міграції й JWT незмінні; fixit_dev не використовується.

**Етап PR #7 реалізував US-08 для CUSTOM. STANDARD частину завершено нижче в US-04:** спільний backend/UI підтримує PENDING → ACCEPTED/DECLINED та подальше виконання. Частина FIX-9 — актуальні стани/дата в історії CLIENT після ручного оновлення, без нового timeline. FIX-17 не виправлявся. API-контракт, точні перевірки, змінені файли й ручний Windows сценарій — [docs/US_08.md](docs/US_08.md).

## US-02 / US-03 — профіль, послуги й каталог

Публічна головна `/` веде до `/catalog`; картки відкривають `/masters/:id` за **MasterProfile.id**. Без JWT доступні серверні city/category/q фільтри та сторінки результатів (типово 12, максимум 50). Категорія фільтру — Service.category, місто — поточне MasterProfile.city. Профіль показує основну категорію й тільки активні послуги. Прямі посилання/F5 у Vite працюють без входу; для production static hosting потрібен SPA fallback.

MASTER у кабінеті відкриває «Профіль і послуги» (`/master/services`): редагує city/category/description профілю, створює/редагує послуги та перемикає isActive. Name/email/password/role/isApproved не редагуються. Основна категорія профілю й категорії послуг незалежні. Немає фізичного DELETE. Nullable priceEstimate зберігається як Decimal(10,2); порожня ціна лишається NULL. Поля зберігаються після помилки; неоднозначний результат мутації потребує GET перед ручним повтором.

На етапі PR #8 дія «Замовити послугу» була disabled; тепер її активовано сценарієм STANDARD, описаним нижче. CUSTOM/пропозиції/lifecycle й FIX-17 незмінні. isApproved залишається internal legacy, не новий approval gate каталогу. Зміни профілю впливають на нову CUSTOM аудиторію, без переписування Order snapshots.

Перевірено **376 backend / 151 frontend / 25 browser E2E**, збережено всі попередні 295/121/22. Coverage тепер охоплює чотири повні модулі без зниження 71% gate; результати по кожному й загальні — [docs/US_02_03.md](docs/US_02_03.md). Cloud helper поточної перевірки: `source /workspace/.fixit-dev/catalog-env.sh`, окрема loopback fixit_catalog_test. Helper та секрети поза Git; інша машина налаштовує свої test bindings.

Повні API-контракти, змінені файли, перевірки й Windows 11 QA — [звіт US-02/03](docs/US_02_03.md). Попередні звіти практичних не переписані.

## US-04 / US-08 — STANDARD на готову послугу

«Замовити послугу» у /catalog і /masters/:id веде до `/orders/new/standard/:serviceId`. Гість входить через безпечний returnTo (тільки цей маршрут з UUID), CLIENT бачить актуальні дані/місто й підтверджує місто перед POST. JWT лишається в пам’яті; returnTo не містить token/особистих даних. MASTER не має CLIENT-доступу до форми/API.

GET `/api/v1/orders/standard/:id` дає CLIENT preview та snapshot fingerprint. POST `/api/v1/orders/standard` приймає serviceId/description та optional expectedSnapshot; masterProfileId/clientId/price/status задаються сервером. createStandard() бере Profile → Service SHARE locks у транзакції й копіює цілісний snapshot; знімок, переглянутий UI, перевіряється під цими ж locks. На зміну ціни/міста — 409, новий GET та повторне підтвердження, без втрати опису. На неоднозначну помилку POST не повторюється автоматично: є inline перевірка власної історії та явне підтвердження ручного повтору.

MASTER бачить CUSTOM і свої STANDARD; для STANDARD PENDING є «Прийняти»/«Відхилити», потім «Розпочати»/«Завершити» через чинний transition(). CLIENT у спільній /orders бачить тип, виконавця, snapshot міста/назви/категорії/ціни, дату й статус; nullable ціна не стає нулем. Скасування PENDING/ACCEPTED логічне, після початку/terminal станів сервер відмовляє. Історія й відхилені/скасовані записи зберігаються.

Фактично **428 backend / 205 frontend / 29 E2E**, попередні 376/151/25 cases збережені (старі disabled/CUSTOM-only очікування адаптовано до нового STANDARD). Typecheck/build/coverage/Prisma/DBML checks пройдено. Окрема loopback fixit_standard_test, приватний `source /workspace/.fixit-dev/standard-env.sh` поза Git. П’ять моделей, три міграції, JWT/CORS/rate limits, CUSTOM і service CRUD/catalog збережені.

[API, locks, перевірки, файли й залишкові ризики](docs/US_04_STANDARD.md) · [Окремий Windows 11 QA checklist та status_history SQL](docs/WINDOWS_STANDARD_QA.md). На етапі PR #9 timeline ще не було; US-09 нижче додає його. FIX-17 та server POST idempotency key залишаються поза обсягом. Звіти попередніх етапів не переписані.

## US-09 — деталі замовлення та історія статусів

CLIENT відкриває «Переглянути деталі» у /orders; MASTER — у «Призначені мені заявки» кабінету. Сторінки read-only, чинні дії/пропозиції залишаються у списках. Показані snapshot, тип, статус, ціна/бюджет, виконавець, created/updated/completed дати й safe timeline із status_history. Cancelled/declined/completed не зникають. MASTER-картки також показують дату створення.

API використовує scoped findFirst: CLIENT clientId + current role, MASTER profile.userId + current role. Деталі MASTER не містять clientId/statusHistory/actorUserId або email/password/JWT; CLIENT detail також прибирає raw audit history. Датовані відомі події впорядковані, невідомий час — null; legacy_migration позначено спостереженням, не вигаданим завершенням. Source в allowlist, actorRole не виводиться без надійного історичного доказу.

Фактично в Cloud: **516 backend / 255 frontend / 33 browser E2E**, попередні 428/205/29 збережені без видалення assertions. Coverage 9 модулів: **96.87 / 90.22 / 98.63 / 99.48%** (Statements / Branches / Functions / Lines), per-file 71% незмінний. Окрема loopback fixit_details_test, ті самі 3 міграції; fixit_dev не використовується. [Повний звіт і Windows 11 QA](docs/US_09_ORDER_DETAILS.md). FIX-17, full realtime та server idempotency тут не реалізуються.
