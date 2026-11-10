# FixIT

Основа MVP сервісу замовлення послуг майстрів. Поточний етап — **практична №7**: реєстрація, JWT-авторизація та React app skeleton поверх перевіреної БД №6. Межі MVP: [FIXIT_MVP_SPEC.md](FIXIT_MVP_SPEC.md).

Стек: Node.js **24 LTS**, npm 11, TypeScript, Express 5, PostgreSQL **18**, Prisma 7.10.1, Jest/Supertest. Frontend — React 19, Vite 8, React Router; окремий npm workspace frontend/. Версії відтворює package-lock.json; Prisma CLI/client/adapter мають однакову версію.

## Файли

```text
docs/er-diagram.dbml                 фізична ER-модель для dbdiagram.io
prisma/schema.prisma                Prisma-модель чотирьох таблиць
prisma/migrations/*/migration.sql    SQL, CHECK, FK та рольові triggers
prisma.config.ts                    Prisma 7: URL/міграції/seeder
prisma/seed.ts                      CLI seeder
src/database/client.ts              PrismaPg + PrismaClient, пул PostgreSQL
src/database/seed.ts                ідемпотентні синтетичні fixtures
src/server.ts                       перевірка БД перед HTTP listen
src/auth/                           паролі, JWT middleware, API авторизації
frontend/                           React/Vite, /login /register /dashboard
tests/                             перевірки конфігурації, БД та HTTP
docs/PRACTICAL_6.md                 історичний звіт №6
docs/PRACTICAL_7.md                 результати №7, Postman/dashboard та QA
```

## Локально на Windows 11 (PowerShell)

Команди Windows наведені для запуску користувачем; у Codex перевіряються Linux/Cloud-команди. Windows/WSL не потрібні хмарному середовищу.

1. Встановіть Git, Node.js 24 LTS з npm і PostgreSQL 18 з офіційних джерел. Запустіть службу PostgreSQL 18. Додайте PostgreSQL `bin` до PATH для psql або використовуйте його повний шлях.
2. Через **локального** адміністратора створіть ізольовані тестові БД. Не використовуйте робочі чи production БД.

```powershell
psql -h 127.0.0.1 -p 5432 -U postgres -d postgres
```

У psql виконайте одноразово. `\password` запитує ваш новий пароль; його не потрібно публікувати:

```sql
CREATE ROLE fixit_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
\password fixit_test
CREATE DATABASE fixit_test OWNER fixit_test;
CREATE DATABASE fixit_shadow OWNER fixit_test;
REVOKE ALL ON DATABASE fixit_test FROM PUBLIC;
REVOKE ALL ON DATABASE fixit_shadow FROM PUBLIC;
\q
```

3. У checkout репозиторію:

```powershell
node --version
npm --version
psql --version
Copy-Item .env.example .env
```

Створіть локальний JWT secret без виведення значення на екран (цей environment діє в поточному PowerShell):

```powershell
$env:JWT_SECRET = node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('hex'))"
```

Або збережіть власний випадковий секрет від 32 байтів у приватному .env. Порожній JWT_SECRET зі зразка не підходить. Зміна ключа після перезапуску робить попередні JWT недійсними.

Відредагуйте **локальний .env**: замініть CHANGE_ME, перевірте порт та назви БД. Символи пароля у URL мають бути percent-encoded. DATABASE_URL і TEST_DATABASE_URL вказують на fixit_test, SHADOW_DATABASE_URL — на окрему fixit_shadow. `.env` ігнорується Git; не показуйте його на скріншотах. `.env.example` містить лише незаповнений зразок.

4. Встановіть і запустіть:

```powershell
npm ci
npm run db:generate
npm run db:validate
npm run db:migrate
npm run db:status
npm run db:seed
npm run db:check
npm run typecheck
npm run er:validate
npm test
npm run frontend:build
npm run frontend:test
npm run dev
```

В іншому PowerShell-вікні запустіть frontend (секрет JWT йому не потрібний):

```powershell
npm run frontend:dev
```

Відкрийте http://127.0.0.1:5173/register. API працює на 3000. У наступному PowerShell-вікні:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
Invoke-RestMethod http://127.0.0.1:3000/health/ready
```

Зупиніть dev через Ctrl+C, виконайте `npm run build`, потім `npm start` для запуску скомпільованого backend.

## У Codex Cloud / FixIT Dev

Використовуйте наявний checkout; окремий worktree не потрібний. Хмарний кластер на **127.0.0.1:55432** не залежить від домашнього Windows/PostgreSQL/WSL. Docker не використовується.

```bash
cd /workspace/FixIT
bash /workspace/.fixit-dev/bin/pg.sh start
source /workspace/.fixit-dev/env.sh
# Штатний офіційний engine; старий source-built override не потрібний.
unset PRISMA_SCHEMA_ENGINE_BINARY PRISMA_MIGRATION_ENGINE_BINARY
export JWT_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("hex"))')"
npm ci
npm run db:generate
npm run db:validate
npm run db:migrate
npm run db:status
npm run db:seed
npm run db:check
npm run typecheck
npm run er:validate
npm test
npm run frontend:build
npm run frontend:test
npm run build
npm start
```

В іншій оболонці виконайте `cd /workspace/FixIT && npm run frontend:dev`; frontend доступний на 127.0.0.1:5173. За потреби скопіюйте frontend/.env.example у frontend/.env.local для іншої локальної адреси API.

Окремим локальним запитом перевірте `/health/ready`. Не публікуйте DATABASE_URL чи вміст env.sh. Живі процеси не відновлюються зі snapshot: у новому завданні знову виконайте `pg.sh start`.

Prisma CLI отримує офіційний schema engine і SHA-256 з `binaries.prisma.sh`. Якщо політика мережі забороняє цей домен, дозвольте його в налаштуваннях. У поточному середовищі офіційне завантаження перевірене без компіляції Rust. Не встановлюйте PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING, не вимикайте TLS і не підміняйте engine порожнім файлом. `src/generated/` генерується db:generate й не комітиться.

## Міграції та seeder

`npm run db:migrate` — **prisma migrate deploy**: застосовує лише наявні SQL-міграції, не створює нових, не скидає БД, не потребує shadow DB. Повторний запуск має повідомити про відсутність pending migrations. Initial migration називається init_database_schema; вона містить також custom CHECK та SQL triggers. Не замінюйте її на db push.

Для **майбутніх змін моделі**: `npm run db:migrate:dev -- --name descriptive_change`. Команда використовує окрему SHADOW_DATABASE_URL. Основна і shadow БД мають бути різними. Не погоджуйте автоматичний reset БД з потрібними даними. У цій практичній reset не виконується.

`npm run db:seed` — транзакційні upsert: п'ять користувачів, два профілі, три послуги, два замовлення. Повторний seed не дублює записи, не переписує passwordHash/createdAt чи історію замовлень. Дані синтетичні (`@fixit.test`), спільного відомого пароля немає. Seeder дозволяє лише loopback-БД із суфіксом `_test`.

`npm test` вимагає **явний TEST_DATABASE_URL**, без fallback на DATABASE_URL, і теж дозволяє лише локальну *_test БД. Спочатку застосуйте міграцію. Інтеграційні тести створюють/оновлюють fixtures; перевірки обмежень використовують rollback. Не запускайте їх проти production або паралельно з ручним редагуванням fixtures.

## Backend і конфігурація

- DATABASE_URL — обов'язковий PostgreSQL connection string; реальних паролів у коді немає.
- HOST — 127.0.0.1 за замовчуванням; PORT — 3000.
- `/health` — liveness, HTTP 200.
- `/health/ready` — реальний SELECT 1 через Prisma, HTTP 200 або 503 без деталей з'єднання.
- JWT_SECRET — обов’язковий environment secret від 32 байтів; JWT_TTL_SECONDS — 900 за замовчуванням (60–86400).
- CORS_ORIGINS — точні дозволені origins через кому; за замовчуванням localhost/127.0.0.1:5173, без wildcard і cookies.
- До listen backend робить $connect і SQL-запит; за недоступної БД завершується з ненульовим кодом та не відкриває порт.
- SIGINT/SIGTERM закривають сервер і Prisma pool. Запуск сервера **не виконує міграції або seed**.

## Авторизація №7

API prefix — `/api/v1`. Операційні `/health` та `/health/ready` залишені для сумісності з №6.

| Метод / маршрут | Поведінка |
| --- | --- |
| POST /api/v1/auth/register | email, password (12–128 символів), name (2–100), role CLIENT/MASTER або CLIENT за замовчуванням; 201 + безпечний user DTO. ADMIN/зайві поля → 400; повторний email → 409. |
| POST /api/v1/auth/login | email/password; 200 + accessToken, tokenType Bearer, expiresIn, user; хибні облікові дані → однаковий 401. |
| GET /api/v1/users/me | Authorization: Bearer JWT; лише id/email/name/role; missing/invalid/expired → 401. |

Нові паролі: scrypt N=32768/r=8/p=3, випадкова сіль 16 байтів, ключ 64 байти. Підтримано формат hash із seeder №6. JWT: HS256, issuer fixit-api, audience fixit-web, обов’язкові sub/exp. Роль береться з БД, не з клієнтських даних. У API діють ліміт JSON 16 KB і 30 auth-спроб за 15 хвилин на IP (спільно register/login). MASTER реєструється без вигаданого міста/профілю; створення профілю залишено наступному етапу.

Frontend має /login, /register, /dashboard. Access token зберігається **лише в пам’яті**: refresh сторінки вимагає нового входу. Logout очищає пам’ять; refresh token, серверна revocation, password reset/email verification ще не реалізовані. JWT залишається дійсним до exp, якщо користувача не видалено або ключ не змінено. Лімітер у пам’яті розрахований на один процес. Це локальний app skeleton, не deployment-конфігурація; для зовнішнього розгортання потрібні HTTPS, відповідні origins і постійне керування секретом.

Каталог/замовлення/відгуки/платежі не реалізовані. БД та SQL-міграція №6 не змінені.

## Перевірки

```bash
npm test                       # 48 backend tests, включно з 25 №6
npm run frontend:test          # 7 frontend tests
npm run frontend:build         # TypeScript + production bundle
# TEST_DATABASE_URL має вказувати на мігровану локальну *_test БД
# У Cloud використовується вже встановлений Chromium:
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
npm run test:e2e               # 5 browser tests; власні backend 4100/frontend 5174
```

На Windows за відсутнього браузера виконайте `npm exec playwright install chromium`, а потім `npm run test:e2e` без PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. Для E2E після налаштування .env не потрібний ручний JWT secret: runner передає backend випадковий ключ через environment. E2E вимагає **явний локальний TEST_DATABASE_URL**, очищує лише власні синтетичні облікові записи, не повторно використовує ваші dev-сервери та не записує bearer-токени у trace/video. В E2E-конфігурації інший PORT не підтриманий: 4100/5174 мають бути вільними.

Фактичні результати та інструкція справжніх Postman/JWT/dashboard скріншотів: [docs/PRACTICAL_7.md](docs/PRACTICAL_7.md). Історичний звіт №6: [docs/PRACTICAL_6.md](docs/PRACTICAL_6.md).
