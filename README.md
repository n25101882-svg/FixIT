# FixIT

Основа MVP сервісу замовлення послуг майстрів. Поточний етап — **практична №6**: фізична ER-модель, PostgreSQL, Prisma migrations, підключення backend і seeder. Межі MVP: [FIXIT_MVP_SPEC.md](FIXIT_MVP_SPEC.md).

Стек: Node.js **24 LTS**, npm 11, TypeScript, Express 5, PostgreSQL **18**, Prisma 7.10.1, Jest/Supertest. React/Vite ще не додано. Версії відтворює package-lock.json; Prisma CLI/client/adapter мають однакову версію.

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
tests/                             перевірки конфігурації, БД та HTTP
docs/PRACTICAL_6.md                 фактичні результати та скріншоти
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
npm run dev
```

В іншому PowerShell-вікні:

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
# Необов'язково: source-built engine, якщо він наданий цим середовищем.
if [ -f /workspace/.fixit-dev/prisma-engine/env.sh ]; then
  source /workspace/.fixit-dev/prisma-engine/env.sh
fi
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
npm run build
npm start
```

Окремим локальним запитом перевірте `/health/ready`. Не публікуйте DATABASE_URL чи вміст env.sh. Живі процеси не відновлюються зі snapshot: у новому завданні знову виконайте `pg.sh start`.

Prisma CLI отримує офіційний schema engine і SHA-256 з `binaries.prisma.sh`. Якщо політика мережі забороняє цей домен, дозвольте його в налаштуваннях. У поточній машині також може бути наданий engine з офіційного source через PRISMA_SCHEMA_ENGINE_BINARY у згаданому env.sh. Не встановлюйте PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING, не вимикайте TLS і не підміняйте engine порожнім файлом. `src/generated/` генерується db:generate й не комітиться.

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
- До listen backend робить $connect і SQL-запит; за недоступної БД завершується з ненульовим кодом та не відкриває порт.
- SIGINT/SIGTERM закривають сервер і Prisma pool. Запуск сервера **не виконує міграції або seed**.

Авторизації та бізнес-API на цьому етапі немає. Інструкція справжніх скріншотів і результати перевірок: [docs/PRACTICAL_6.md](docs/PRACTICAL_6.md).
