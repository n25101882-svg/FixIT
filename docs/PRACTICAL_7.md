# Практична №7 — Auth і атомарна MASTER-реєстрація

Реалізація та фактична інтеграційна перевірка **14.11.2026**, гілка `feature/practical-07-auth-skeleton`, [PR #2](https://github.com/n25101882-svg/FixIT/pull/2) до develop. Виконано [інтеграційне завдання з Conversation](https://github.com/n25101882-svg/FixIT/pull/2#issuecomment-6880147986) після merge [PR #3](https://github.com/n25101882-svg/FixIT/pull/3).

## Основа та збереження Hybrid

Актуальний develop `f7d7684ee0751e436a4a4165acca7bc1137bb8d9` інтегровано локальним merge-комітом `eddaefd`; конфлікти README.md, FIXIT_MVP_SPEC.md та package.json розв’язані. Збережено frontend/Auth workspace dependencies/scripts і Hybrid test:migrations. Lockfile вже містив Auth/frontend dependencies, змін не потребував; чистий npm ci підтвердив узгодженість.

Від develop **побайтово незмінні** Prisma schema, фізична DBML, src/orders/service.ts, усі чотири файли попередніх 82 тестів та три міграції:

1. `20261109200000_init_database_schema`
2. `20261114130000_hybrid_mvp`
3. `20261114150000_review_snapshot_alignment`

Нових таблиць/міграцій не додано. Схема — users/master_profiles/services/orders/order_responses, Prisma 7.10.1, PostgreSQL 18, decimal(10,2). Поточна auth-реалізація працює поверх Hybrid, не повертає 4-табличну модель/cents. `fixit_dev`, production, домашній PostgreSQL/WSL не використовувалися. Reset/db push не запускалися. PR #2 автоматично не merge-иться.

## API та критерії FIX-1

### Реєстрація CLIENT

POST `http://127.0.0.1:3000/api/v1/auth/register`, Content-Type application/json:

```json
{
  "email": "synthetic-client@fixit.test",
  "password": "<власна локальна тестова фраза від 12 символів>",
  "passwordConfirmation": "<та сама локальна тестова фраза>",
  "name": "Синтетичний клієнт",
  "role": "CLIENT"
}
```

CLIENT створює **тільки User**. MASTER-поля в CLIENT payload відхиляються, а не ігноруються/масово присвоюються. Role без значення типово CLIENT; ADMIN/невідомий role → 400. PasswordConfirmation додано як обов’язкове поле обох ролей відповідно до FIX-1; старі ручні POST-запити потрібно доповнити ним.

### Реєстрація MASTER

```json
{
  "email": "synthetic-master@fixit.test",
  "password": "<власна локальна тестова фраза від 12 символів>",
  "passwordConfirmation": "<та сама локальна тестова фраза>",
  "name": "Синтетичний майстер",
  "role": "MASTER",
  "city": "Синтетичне місто",
  "category": "PLUMBING",
  "profileDescription": "Синтетичний опис досвіду майстра.",
  "serviceTitle": "Перша синтетична послуга",
  "serviceDescription": "Синтетичний короткий опис цієї послуги.",
  "priceEstimate": "250.50"
}
```

priceEstimate можна **не передавати**, тоді в БД NULL; JSON number, null, empty string, negative/overflow/NaN/exponent/comma або 3+ fractional digits відхиляються. React порожню ціну пропускає; заповнену передає рядком без Float/Number. Обидва описи окремі: profileDescription описує майстра, serviceDescription — послугу. Автоматично не дублюємо їх і не вигадуємо місто/послугу.

| Поле | Валідація до запису |
| --- | --- |
| name | trim, 2–100 символів |
| email | trim/lowercase, email, максимум 254; UNIQUE у PostgreSQL |
| password / passwordConfirmation | 12–128 символів, точний збіг, без trim пароля |
| role | CLIENT / MASTER, типово CLIENT; ADMIN заборонено |
| city | MASTER required, trim, 1–100 |
| category | MASTER required: TECH_REPAIR / PLUMBING / ELECTRICAL / OTHER |
| profileDescription | MASTER required, trim, 1–2000 |
| serviceTitle | MASTER required, trim, 1–160 (межа збереженої Hybrid схеми) |
| serviceDescription | MASTER required, trim, 1–2000 |
| priceEstimate | MASTER optional, exact decimal string, 1–8 integer digits, до 2 fractional digits, 0..99999999.99 |

Невідомі/захищені поля (id, passwordHash, isApproved, nested ownership тощо) відхиляються strict-schema до hash/запису. MASTER виконує **одну Prisma transaction**: User → MasterProfile → перша Service; обидві category з одного перевіреного input. isApproved — legacy false, не approval gate; Service.isActive типово true. Помилка будь-якого INSERT або commit відкочує все. Лише після await успішного commit надсилається **201** `{user:{id,email,name,role}}`; passwordHash і token не повертаються. Реєстрація веде на /login, JWT видається окремим login.

Validation → 400 з field errors; duplicate/race canonical email → 409 EMAIL_TAKEN; несподівана DB-помилка → redacted 500 без SQL/stack/credentials/201/token. UNIQUE email і транзакція гарантують, що race не створює додаткові профілі/послуги.

### Login та users/me

POST `/api/v1/auth/login`, body `{ "email": "...", "password": "..." }` → 200 з accessToken, tokenType=Bearer, expiresIn (типово 900), user із чотирма полями. Неправильний пароль/відсутній account → однаковий 401; unknown account теж виконує scrypt comparison.

Паролі: salted scrypt N=32768/r=8/p=3, random salt 16 bytes, key 64 bytes. Старий seed scrypt N=16384/r=8/p=1 також підтриманий; hashes не переписуються, спільного відомого seed-пароля немає.

JWT: HS256, issuer fixit-api, audience fixit-web, subject User.id UUID, exp. JWT_SECRET тільки з environment, мінімум 32 bytes; middleware перевіряє підпис, algorithm/issuer/audience/subject/exp. GET `/api/v1/users/me` із Bearer → 200 лише id/email/name/role з актуального User. Missing/invalid/expired token, wrong key/algorithm/audience, missing exp або deleted account → 401. Жодного passwordHash у DTO.

Точні CORS origins для localhost/127.0.0.1:5173, без wildcard/cookies; auth limiter 30/15 хвилин/IP; JSON до 16 KB; redacted errors і no-store збережені. /health і /health/ready працюють. Order/catalog endpoints не додаються; Hybrid команди залишаються внутрішніми.

## Frontend

React/Vite/TypeScript workspace frontend/, React Router. /register умовно показує MASTER city/category/profile description/first service fields, optional price; CLIENT їх не відправляє навіть після перемикання ролі. Password confirmation перевіряється в UI і на сервері. Обов’язкові поля, accessible labels/field errors, busy state, responsive layout збережені.

Після register → /login; після login → /dashboard, який виконує реальний users/me і показує email/name/role. Protected Route перенаправляє гостя; users/me 401 очищує сесію; logout очищує token і веде на login. Token тільки в пам’яті, без localStorage/sessionStorage; refresh вимагає login. Не додаються ADMIN UI, каталог/замовлення/Reviews/платежі/чат.

## Фактичні перевірки

Середовище: Node 24.22.1, npm 11.9.0, Prisma 7.10.1, TypeScript 5.9.3, PostgreSQL 18.6, Chromium 156.0.8078.79. Використані нові окремі loopback БД `fixit_auth_hybrid_test`, `fixit_auth_hybrid_clean_test`, `fixit_auth_hybrid_upgrade_test` та окрема shadow. Credentials/URL не публікуються.

| Команда / перевірка | Фактичний результат |
| --- | --- |
| npm ci --no-audit --no-fund | Чисте встановлення 635 packages за збереженим workspace lockfile |
| npm run db:generate / db:validate | Client 7.10.1 згенеровано; schema valid |
| npm run db:migrate / db:status | Усі 3 міграції застосовані; schema up to date; повторний deploy No pending migrations |
| npm run typecheck | Backend, seed, Prisma config/TS helpers — PASS |
| npm run er:validate | 5 таблиць, 7 FK включно зі складеним ownership service/master — PASS |
| npm test | **145/145, 6 suites, 0 failed/skipped**: незмінені 82 Hybrid + 23 Auth + 40 FIX-1 endpoint integration |
| npm run build | TypeScript backend build — PASS (також виконувався test/e2e/migration scripts) |
| npm run frontend:build | Frontend TypeScript + Vite production build — PASS |
| npm run frontend:test | **12/12**: попередні 7 сценаріїв + 5 conditional MASTER/CLIENT, price string, confirmation, validation cases |
| npm run test:e2e | **5/5**, реальні Express/PostgreSQL + Vite + Chromium, без mocks HTTP/БД |
| npm run test:migrations | **PASS**, нова порожня clean/upgrade pair, всі 3 міграції, повторний deploy/seed, legacy upgrade/backfill/rollback |
| npm run db:check | SQL connection, PostgreSQL 18.6, 5 таблиць, всі 3 applied migrations |
| prisma migrate diff --from-migrations prisma/migrations --to-config-datasource --exit-code | No difference detected, exit 0 |
| Git byte comparison з develop | Усі 3 SQL, Prisma schema, DBML, order commands і 4 файли 82 тестів незмінні |
| Після cleanup Auth/E2E | **0** тимчасових Auth/registration/browser accounts; **0** test-only SQL constraints |

Нові endpoint-тести: кожна категорія MASTER із nullable price, точні 0/12.34/max decimal; CLIENT лише User; actual DB failure першої Service → 500 без success/token, нуль часткових записів, наступний retry успішний; duplicate canonical email; паралельні MASTER/MASTER і CLIENT/MASTER → один 201, один 409 без orphan. Invalid required fields/bounds/category/money/confirmation/ADMIN/mass assignment → 400 **до $transaction**, counts незмінні. Для MASTER додатково перевірені login 200 + JWT, users/me 200/401, safe DTO.

Для справжньої помилки третього INSERT тест тимчасово додає CHECK із випадковим synthetic marker **тільки в перевірену *_test БД**, надсилає валідний payload і перевіряє повний rollback. CHECK видаляється у finally; міграційні файли не редагуються. Auth/E2E cleanup видаляє тільки власні synthetic records у порядку Service → Profile → User, не обходить RESTRICT FK.

Перший backend-прогін мав 6 помилок нового test helper: пошук за uppercase email не враховував правильну server lowercase-нормалізацію. Helper виправлено; фінальний повний прогін — 145/145. Попередні JWT/CORS/rate-limit/JSON/hash tests не послаблювалися. npm має успадковане glob deprecation warning; Jest — VM modules experimental warning, Playwright — color-env warning. Вони не є skipped tests; security audit не заявляється.

E2E: guest redirect; реальні CLIENT і MASTER register → wrong password → login → users/me → dashboard → logout, перевірка persisted Profile/Service/category/decimal для MASTER та відсутності Profile у CLIENT; duplicate email; mobile MASTER form 390×844 без horizontal overflow. Frontend unit-тести mock HTTP, E2E — реальний backend/БД. Trace/video/screenshots runner-а вимкнені, секрети не записуються в звітні captures.

Migration verifier окремо підтвердив clean chain/repeat seed без зміни persisted state, незмінений initial → 5 old Orders усіх старих statuses → незмінений Hybrid → review migration. Збережені IDs/links/descriptions/createdAt/exact cents (0/1/max int), legacy nullable biography/history; snapshot guard та rollback працюють; повторний deploy не змінив даних, applied checksums збігаються. Бази збережені для огляду, для нового прогону потрібна нова порожня pair.

На головній test БД після двох backend-прогонів і E2E: **5 users / 2 profiles / 3 services / 5 orders / 6 responses**. Відмінність від seed fixtures (3 orders/2 responses) — дві синтетичні committed concurrency-перевірки Hybrid, по одній на прогін. Їхня історія навмисно збережена; це не користувацькі дані. Решта мутацій Hybrid відкочується.

## Запуск, Windows і Cloud

Детальні команди створення окремих test DB/ролі, приватного .env/JWT_SECRET, встановлення та запуску — [README](../README.md). Звичайні порти **backend 3000 / frontend 5173**. E2E окремо використовує **4100/5174**, генерує випадковий secret і не під’єднується до вже запущених серверів.

Cloud у цій машині:

```bash
cd /workspace/FixIT
bash /workspace/.fixit-dev/bin/pg.sh start
source /workspace/.fixit-dev/auth-hybrid-env.sh
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

Helper приватний, поза Git, задає лише локальні test URLs/Chromium; на іншій машині потрібні власні дозволені bindings. Для ручного npm run dev потрібен JWT_SECRET із захищеного environment/приватного .env; у root .env.example він порожній. Ніякого TLS/checksum bypass/native engine override/Rust compilation. Prisma URL тільки у prisma.config.ts; migrate dev потребує окремої shadow. Не запускати reset/db push, не мігрувати fixit_dev без окремої перевірки/backup.

Windows/PowerShell: налаштуйте root .env за .env.example, виконайте список npm-команд README; `npm run dev` у першому терміналі, `npm run frontend:dev` у другому. Для E2E на Windows `npm exec playwright install chromium`, не задавайте Linux executable path. **Windows і Postman тут не запускалися.**

## Три обов’язкові справжні screenshots №7

Нижче — інструкція отримання доказів вручну, а не твердження, що ці screenshots уже створені. Використовуйте власні synthetic @fixit.test accounts, не справжні персональні дані. Не публікуйте .env, JWT_SECRET, password, повний чинний JWT чи environment export із секретами.

### 1. Postman: POST login 200, JWT замаскований

1. Запустіть локальний backend з приватним JWT_SECRET. У Postman локально задайте baseUrl=http://127.0.0.1:3000, email=унікальний synthetic @fixit.test, password=свою тестову фразу. Password і accessToken — локальні Secret variables; environment зі значеннями не експортуйте.
2. POST `{{baseUrl}}/api/v1/auth/register` із CLIENT JSON нижче, очікуйте реальний 201. Для MASTER додайте city/category/profileDescription/serviceTitle/serviceDescription з прикладу вище; optional priceEstimate — рядок. Для повторного email очікуваний 409; не змінюйте відповідь для screenshots.

```json
{
  "email": "{{email}}",
  "password": "{{password}}",
  "passwordConfirmation": "{{password}}",
  "name": "Синтетичний користувач",
  "role": "CLIENT"
}
```

3. POST `{{baseUrl}}/api/v1/auth/login`, raw JSON `{ "email": "{{email}}", "password": "{{password}}" }`, Send. У кадрі мають бути **метод/URL, HTTP 200 і справжня відповідь** accessToken/tokenType/expiresIn/user. Зробіть screenshot фактичного Postman; перед публікацією **замаскуйте значення JWT на копії знімка**, позначивши редагування «JWT замасковано». Не підміняйте статус/поля/результат. Secret/password не показуйте, environment panel закрийте.
4. Додатково: локально використайте реальний token для GET `{{baseUrl}}/api/v1/users/me` з Bearer → 200, лише id/email/name/role; без Authorization → реальний 401. Authorization value також приховуйте у спільному звіті. Після QA завершіть локальну сесію/дочекайтеся exp або змініть dev-key.

### 2. Browser: /dashboard із synthetic email

1. Відкрийте **http://127.0.0.1:5173/register**. Перевірте CLIENT: MASTER-полів немає; MASTER: усі required profile/first Service поля з’являються, price optional. Заповніть справжні синтетичні дані, password confirmation і зареєструйтесь.
2. Після переходу на /login увійдіть. На **/dashboard** дочекайтеся users/me; у кадрі мають бути browser URL, synthetic email, name, role та «Вийти». Зніміть фактичний браузер, на Windows можна Win+Shift+S. Не відкривайте token у DevTools для цього кадру.
3. Перевірте logout → login і protected redirect. Refresh перед screenshot не робіть: in-memory token навмисно втрачається. Якщо оновили сторінку — увійдіть знову, не підставляйте дані вручну в DOM.

### 3. Backend terminal: DB connected і listen

1. У приватному .env налаштовані isolated PostgreSQL/JWT_SECRET, PORT=3000. Запустіть `npm run dev` (або після build `npm start`). Не виконуйте поруч echo .env/DATABASE_URL/JWT_SECRET.
2. Дочекайтеся **справжнього** рядка `FixIT backend listening on 127.0.0.1:3000; database connected.` — він з’являється після SQL connection check і успішного HTTP listen.
3. Зніміть термінал із командою/цим рядком без секретів. Додатково можна показати реальний GET http://127.0.0.1:3000/health/ready → 200/database=up, але він не заміняє обов’язковий terminal кадр.

Можливі назви: 07-postman-login-masked.png, 07-dashboard.png, 07-backend-connected.png. Ці звітні файли тут не заявляються створеними; внесок інших учасників, Windows QA, screenshots і CI результати не вигадуються.

## Обмеження та завершення

Token лише in-memory, без refresh/revocation/password reset/email verification. Logout очищує клієнт, JWT може діяти до exp. Limiter — single-process memory store; зовнішній deployment потребує HTTPS/secret management/exact origins/SPA fallback і не є цим PR. Каталог/order routes/Reviews/ADMIN UI/payments/chat залишаються поза scope. PR #2 лишається відкритим до develop для review й локальної QA; автоматичного merge немає.
