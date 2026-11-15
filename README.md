# FixIT — Hybrid MVP, Auth, CUSTOM-заявки та пропозиції майстрів

Node.js 24 / npm 11, Express + TypeScript, PostgreSQL 18, Prisma 7.10.1; React + Vite + TypeScript. Hybrid database PR #3 і Auth PR #2 merged у develop (`e046255`). Практична №9 додає вертикальний CUSTOM orders flow React → JWT API → PostgreSQL → React. US-06/US-07 продовжують його: пропозиції майстрів і атомарний вибір виконавця; база develop після PR #5 (`70617b9`).

П’ять таблиць: users, master_profiles, services, orders, order_responses. Усі три застосовані SQL-міграції з develop збережені без змін. Грошові поля — decimal(10,2), зокрема nullable Service.priceEstimate (`price_estimate`); Float не використовується. [Специфікація](FIXIT_MVP_SPEC.md), [фізична DBML](docs/er-diagram.dbml), [звіт №6](docs/PRACTICAL_6.md), [звіт №7](docs/PRACTICAL_7.md), [звіт №9 і Windows/Network/PostgreSQL QA](docs/PRACTICAL_9.md).

## Що працює

- POST `/api/v1/auth/register`: CLIENT → тільки User; MASTER → одна транзакція User + MasterProfile + перша Service. Валідація до запису, помилка будь-якого INSERT/commit → rollback, success лише після commit. Публічна ADMIN-реєстрація і mass assignment заборонені.
- POST `/api/v1/auth/login`: salted scrypt password verification і короткоживучий HS256 JWT; secret тільки з environment.
- GET `/api/v1/users/me`: JWT-захист, лише id/email/name/role; missing/invalid/expired → 401. Точні CORS origins, JSON size limit і auth rate limiting збережені.
- React `/register`, `/login`, protected `/dashboard`, повідомлення про помилки і logout. MASTER-поля показуються лише для MASTER; CLIENT їх не надсилає. Token лише в пам’яті; refresh потребує повторного входу.
- Захищені CLIENT GET/POST `/api/v1/orders`, DELETE `/api/v1/orders/:id`: власний список, CUSTOM OPEN, логічне CANCELLED через наявний сервіс; скасовані записи/історія збережені. React `/orders` відкривається з кабінету, оновлює список без reload і показує Loading/Empty/Error/Success.
- US-06/US-07: MASTER `/master/orders` показує OPEN CUSTOM за профільним містом/категорією і приймає текстову пропозицію; CLIENT `/orders` читає свої пропозиції й обирає одного виконавця. Кабінет MASTER показує призначені CUSTOM та поточні статуси, включно з кінцевими. [API, перевірки та Windows QA](docs/US_06_07.md).
- `/health`, `/health/ready` та чинна транзакційна логіка `src/orders/service.ts` збережені. Каталог, Reviews, ADMIN UI, платежі та чат не додаються.

## Windows / PowerShell

Потрібні Git, Node 24/npm 11, PostgreSQL 18 і psql у PATH. Використовуйте окремі локальні *_test БД; fixit_dev/production не використовувати для тестів/seed. Жодного Docker/WSL/домашньої мережі для Cloud не потрібно.

Через власного локального адміністратора (`psql -h 127.0.0.1 -U postgres -d postgres`) створіть **лише відсутні** роль і тестові БД. Якщо роль/БД уже існують, не видаляйте й не перевизначайте пароль автоматично.

```sql
-- Тільки якщо роль відсутня:
CREATE ROLE fixit_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password fixit_test
CREATE DATABASE fixit_orders_test OWNER fixit_test;
CREATE DATABASE fixit_shadow OWNER fixit_test;
-- Дві окремі НОВІ ПОРОЖНІ *_test БД тільки для test:migrations:
CREATE DATABASE fixit_orders_clean_test OWNER fixit_test;
CREATE DATABASE fixit_orders_upgrade_test OWNER fixit_test;
```

```powershell
Copy-Item .env.example .env
```

У приватному .env задайте власний percent-encoded пароль локальної ролі, DATABASE_URL/TEST_DATABASE_URL для fixit_orders_test, SHADOW_DATABASE_URL для окремої fixit_shadow. Схема — public. Для test:migrations задайте CLEAN_DATABASE_URL і UPGRADE_DATABASE_URL двох порожніх БД вище, відмінних від головної. Не публікуйте .env, паролі чи реальні URL.

Згенеруйте випадковий JWT_SECRET локально і перенесіть значення **тільки** у приватний .env:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Не знімайте цей вивід для звіту. JWT_SECRET має бути мінімум 32 bytes, JWT_TTL_SECONDS типово 900. Після налаштування:

```powershell
npm ci
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

Backend: **http://127.0.0.1:3000**, frontend: **http://127.0.0.1:5173**. VITE_API_URL типово http://127.0.0.1:3000/api/v1; root CORS_ORIGINS містить точні http://127.0.0.1:5173 і http://localhost:5173. Optional frontend/.env створюйте з frontend/.env.example; жодних JWT_SECRET/DATABASE_URL у VITE_*.

Для Playwright використайте Chromium поточного runner:

```powershell
npm exec playwright install chromium
npm run test:e2e
```

На Windows не задавайте Linux PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. E2E запускає власні сервери на **4100/5174** із випадковим environment secret; це окремі test ports, а не звичайні 3000/5173. Використовується явний локальний TEST_DATABASE_URL; існуючі сервери не перевикористовуються. Trace/video/screenshots вимкнені, test-results і playwright-report ігноруються Git. Windows/Postman QA тут **документована, не виконана**.

## Codex Cloud

Cloud має власний локальний PostgreSQL кластер, незалежний від домашнього Windows/WSL. У поточній підготовленій машині:

```bash
cd /workspace/FixIT
bash /workspace/.fixit-dev/bin/pg.sh start
source /workspace/.fixit-dev/orders-env.sh
unset PRISMA_SCHEMA_ENGINE_BINARY PRISMA_MIGRATION_ENGINE_BINARY
npm ci
npm run db:generate
npm run db:validate
npm run db:migrate
npm run db:status
npm run typecheck
npm run er:validate
npm test
npm run frontend:build
npm run frontend:test
npm run test:e2e
npm run test:migrations
```

orders-env.sh — приватний helper цієї машини поза Git; використовує попередні приватні helpers і задає нові fixit_orders*_test БД на 127.0.0.1:55432 й установлену /usr/bin/chromium. На іншій машині налаштуйте власні дозволені TEST/DATABASE/SHADOW bindings та Chromium; автоматичного відновлення helper не заявляємо. У цьому helper немає production-секретів. Для ручного dev додатково задайте JWT_SECRET через захищене environment або приватний .env; E2E генерує власний випадковий secret.

Prisma працює зі штатним engine, TLS/checksum verification не вимикаються, Rust compilation/override не потрібні. URL задається у prisma.config.ts. Для migrate dev потрібна окрема shadow database. Використовуйте migrate deploy, не db push/reset; для робочих даних потрібні окрема перевірка/backup. Backend startup не виконує seed/міграцій, перевіряє SQL-з’єднання перед listen; SIGINT/SIGTERM закриває пул.

## Реєстрація та QA

Спільні поля: name, email, password, **passwordConfirmation**, role CLIENT/MASTER (типово CLIENT). MASTER додатково: city, category (TECH_REPAIR/PLUMBING/ELECTRICAL/OTHER), profileDescription, serviceTitle, serviceDescription; optional priceEstimate, наприклад рядок `"250.50"`. Описи окремі, profile/first Service отримують одну category; ніяких placeholder. CLIENT MASTER-полів не надсилає. Межі/повні JSON/Postman приклади — у звіті №7.

Для практичної №9 у Cloud фактично пройшли **198 backend тестів** (попередні **145** + **53 Orders API**), **48 frontend тестів** (усі попередні **27** + **21 review regression**), **15 browser E2E** (усі попередні **10** + **5 review regression**). Перевірені rollback реальної помилки першої Service, duplicate/race email, валідація до запису, обидві ролі, JWT/CORS/rate limits, nullable exact prices і три міграції clean/legacy upgrade. Повний список команд і результатів — [PRACTICAL_9.md](docs/PRACTICAL_9.md).

Попередні Auth/browser тести створюють випадково іменовані синтетичні акаунти та видаляють тільки свої Service → Profile → User, не обходячи RESTRICT FK. Нові US-06/US-07 тести зберігають synthetic cohort і вибрані OrderResponse/історію в ізольованій *_test БД, оскільки SQL забороняє видаляти вибрану пропозицію. Hybrid concurrency-тест навмисно лишає одну власну синтетичну заявку/пропозиції на кожний прогін тільки в ізольованій *_test БД; інші мутації відкочуються. Seed fixtures: 5 users / 2 profiles / 3 services / 3 orders / 2 responses; global counts після concurrency можуть бути більшими. Seed-акаунти не мають відомого спільного пароля; для login створіть свій синтетичний account.

Для №7 потрібні три **справжні** screenshots: Postman POST login 200 із замаскованим JWT, браузер /dashboard із synthetic email, backend terminal із database connected/listen. Покрокова інструкція — у [звіті №7](docs/PRACTICAL_7.md). Звітні screenshots, Windows чи Postman execution тут не вигадуються.

Для №9 у браузері CLIENT відкрийте /dashboard → «Мої заявки», створіть CUSTOM із title/description/city/category і optional budget (точний рядок). Скасування — тільки до початку робіт, запис залишається у списку зі статусом «Скасована». Зміни з інших сесій видно після «Оновити»; GET без пагінації/query-фільтрів. Windows QA та три реальні докази (/orders, Network HTTP 200/201, PostgreSQL SELECT) описані у звіті №9; скріншоти/Windows execution тут не вигадуються.

PR #4 review / FIX-18: перед DELETE є клавіатурний діалог з «Ні», Escape і закриттям без запиту; після 409 виконується автоматичний GET зі збереженням повідомлення про конфлікт. Помилка повторного GET має власний retry, застаріле скасування заблоковане. Форма лишається доступною під час loading/мережевих/5xx помилок історії; 401 завершує сесію, 403 блокує CLIENT-функції. FIX-17 (F5/session) не змінений. Фактичні перевірки від 15.11.2026 й межі — у review-розділі звіту №9.

## Практична №10 — Unit Code Coverage

Vitest і @vitest/coverage-v8 мають сумісну exact-версію **5.1.0**. З кореня репозиторію: `npm ci`, потім **`npm run frontend:coverage`**. Вимірюються повні orders.tsx і CancelOrderDialog.tsx; per-file gate — 71% для Statements/Branches/Functions/Lines. HTML — frontend/coverage/index.html (PowerShell: `Start-Process .\frontend\coverage\index.html`), JSON і assets поряд; generated coverage ігнорується Git. Unit coverage не потребує PostgreSQL/JWT_SECRET.

У перевірці №10: **198 backend / 60 frontend / 15 E2E**, старі 48 frontend-сценаріїв збережені, додано 12 ізольованих AAA cases. orders.tsx: **96.49 / 88.69 / 100 / 100%**, CancelOrderDialog.tsx: **96.77 / 95.65 / 100 / 100%** у порядку Statements / Branches / Functions / Lines. FIX-18 регресійно підтверджено; FIX-17 не виправлявся. [Звіт №10, точні counts і Windows QA](docs/PRACTICAL_10.md). Попередні навчальні звіти не змінені.

## US-06/US-07 — пропозиції майстрів

Гілка `feature/us-06-07-master-offers` від develop після PR #5. Власник CLIENT відкриває «Переглянути пропозиції» у /orders і обирає майстра. MASTER переходить із кабінету до «Заявки для майстра», надсилає одну текстову пропозицію; призначену заявку бачить у /dashboard. «Оновити» перечитує стан з API; realtime/pagination не додаються.

`npm run test:e2e` послідовно запускає попередню регресію та нові `@offers` сценарії з окремими процесами серверів. Це ізолює synthetic auth traffic і лічильник штатного rate limiter, без зміни auth-конфігурації. Обидва запуски обов’язкові, JSON-звіти окремі в ігнорованому test-results/. Cloud helper поточного запуску: `source /workspace/.fixit-dev/offers-env.sh` (приватний, поза Git), БД `fixit_offers_test`. На Windows налаштуйте свою локальну *_test БД за інструкцією вище.

Повний звіт із фактичними перевірками, обмеженнями й командами — [docs/US_06_07.md](docs/US_06_07.md). Звіти попередніх практичних не переписуються.
