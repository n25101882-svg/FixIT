# FixIT — Hybrid MVP 1.0

Практична №6: PostgreSQL 18, Prisma 7.10.1, Node.js 24 LTS/npm 11, Express/TypeScript. П’ять сутностей: User, MasterProfile, Service, Order (STANDARD/CUSTOM), OrderResponse. Auth/React із відкритого PR #2 у цю гілку не включені.

[Специфікація](FIXIT_MVP_SPEC.md) · [DBML](docs/er-diagram.dbml) · [Звіт №6 та інтеграція з PR #2](docs/PRACTICAL_6.md).

## Основні файли

- prisma/schema.prisma — модель; datasource URL тільки у prisma.config.ts.
- prisma/migrations/20261109200000_init_database_schema — незмінена initial migration.
- prisma/migrations/20261114130000_hybrid_mvp — послідовне перетворення зі збереженням даних.
- src/orders/service.ts — транзакційні createStandard/createCustom/respond/selectResponse/transition.
- src/database/seed.ts — синтетичні idempotent fixtures для всіх п’яти таблиць.
- scripts/verify-migrations.mjs — перевірка чистої БД та upgrade старих записів.

Гроші — UAH decimal(10,2). Старі cents точно діляться на 100; нові вхідні ціни — десяткові рядки, без float/неявного округлення. User й passwordHash контракт збережено для майбутнього Auth. ADMIN — лише внутрішня сумісність; нового публічного призначення ADMIN немає.

## Локально на Windows (PowerShell)

Потрібні Git, Node 24/npm 11, запущена PostgreSQL 18, psql у PATH. Не використовуйте fixit_dev/production або базу з потрібними даними для тестів. Роль fixit_test має бути звичайним локальним login без SUPERUSER/CREATEDB/CREATEROLE. Якщо вона вже є після №6, не перевизначайте пароль і не видаляйте її.

Одноразово через свого локального адміністратора (`psql -h 127.0.0.1 -U postgres -d postgres`) створіть лише відсутні тестові БД:

```sql
-- Тільки якщо роль ще не існує:
CREATE ROLE fixit_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password fixit_test
CREATE DATABASE fixit_hybrid_test OWNER fixit_test;
CREATE DATABASE fixit_hybrid_shadow OWNER fixit_test;
-- Дві окремі НОВІ ПОРОЖНІ БД для migration verification:
CREATE DATABASE fixit_hybrid_clean_test OWNER fixit_test;
CREATE DATABASE fixit_hybrid_upgrade_test OWNER fixit_test;
```

Пароль вводиться локально через запит psql; не публікуйте його. Для БД із даними потрібні окрема перевірка й резервна копія, а не reset. Ця інструкція створює нові ізольовані БД.

```powershell
Copy-Item .env.example .env
```

У приватному .env задайте DATABASE_URL/TEST_DATABASE_URL для fixit_hybrid_test, SHADOW_DATABASE_URL для окремої fixit_hybrid_shadow. Для додаткової перевірки — CLEAN_DATABASE_URL і UPGRADE_DATABASE_URL для двох порожніх *_test БД вище. Значення пароля у URL має бути percent-encoded. Приклад не містить реальних credentials; .env ігнорується Git. Підтримана схема — public.

```powershell
npm ci
npm run db:generate
npm run db:validate
npm run db:migrate
npm run db:status
npm run db:seed
npm run db:seed
npm run db:check
npm run typecheck
npm run er:validate
npm test
npm run build
npm run test:migrations
npm start
```

`npm run test:migrations` не очищує БД: відмовиться працювати, якщо clean/upgrade бази не порожні. Для нового прогону створіть нову пару порожніх *_test БД і змініть лише їхні приватні environment bindings. Після прогону БД збережені для огляду. Ні reset, ні db push не використовуються. Команди Windows документовані, але фактичні перевірки цього PR виконані в Linux Cloud.

## Codex Cloud

Використовуйте наявний checkout. Кластер локальний для Cloud, не залежить від домашніх Windows/WSL/PostgreSQL, Docker не потрібний. У підготовленій машині:

```bash
cd /workspace/FixIT
bash /workspace/.fixit-dev/bin/pg.sh start
source /workspace/.fixit-dev/hybrid-env.sh
unset PRISMA_SCHEMA_ENGINE_BINARY PRISMA_MIGRATION_ENGINE_BINARY
npm ci
npm run db:generate
npm run db:validate
npm run db:migrate
npm run db:migrate
npm run db:seed
npm run db:seed
npm run typecheck
npm run er:validate
npm test
npm run build
npm run db:check
npm start
```

hybrid-env.sh — приватний helper середовища поза Git, читає пароль із локального захищеного файлу, задає окремі дозволені *_test URL. Якщо його немає в іншій машині, налаштуйте власні ізольовані TEST/DATABASE/SHADOW bindings і доступ до локальної PostgreSQL перед командами. Автоматичного відновлення цього helper у новій задачі не заявляємо. Порт поточного тестового кластера — 127.0.0.1:55432. Реальні рядки підключення не друкуйте.

Prisma використовує штатний engine з binaries.prisma.sh із TLS/checksum verification. Rust/source-built override більше не потрібний. Для migrate dev потрібна окрема SHADOW_DATABASE_URL; поточні migrations застосовуються через migrate deploy. Не використовуйте prisma db push або migrate reset.

## Backend і команди

Backend перевіряє реальне SQL-з’єднання до HTTP listen, /health повертає liveness, /health/ready виконує SELECT 1. HOST/PORT типово 127.0.0.1/3000. SIGINT/SIGTERM закриває HTTP та пул. db:check перевіряє версію, п’ять таблиць і наявність Hybrid migration. Запуск backend не виконує seed/міграції.

У src/orders/service.ts всі мутації перевіряють роль і належність та виконуються транзакційно. createStandard бере активну Service/майстра й фіксує ціну; createCustom починає OPEN; respond бере профіль actor-а з БД; selectResponse серіалізує конкурентний вибір через FOR UPDATE; transition перевіряє дозволений стан/власника. Наразі це **внутрішній сервіс**, а не незахищений REST API: actorId у майбутньому передаватиме перевірений JWT middleware PR #2, не клієнтський body.

Seed містить 5 users (з legacy ADMIN), 2 профілі, 3 послуги, 2 STANDARD + 1 OPEN CUSTOM і 2 пропозиції. PasswordHash/createdAt/ціни й статуси наявних Orders не переписуються. Синтетичні @fixit.test акаунти не мають відомого спільного пароля. Seed і Jest вимагають локальну *_test БД, TEST_DATABASE_URL не підміняється DATABASE_URL.

49 Jest/Supertest перевірок охоплюють ролі, FK/UNIQUE/CHECK, статуси, типи, точні ціни, snapshot, history, seed, backend та реальну конкурентну selection. Один concurrency-тест навмисно залишає власну синтетичну заявку/пропозиції в ізольованій тестовій БД: це два справжні committed transactions, а не mock. Інші мутації тестів відкочуються. Не використовуйте ці тести проти робочих даних.

test:migrations окремо виконує clean deploy обох міграцій, seed/rerun, initial-only legacy fixtures, перевіряє атомарну відмову невідомої категорії, upgrade п’яти старих замовлень та повторний deploy без змін. Основна тестова БД та clean/upgrade мають бути різними. SQL-обмеження й план інтеграції Auth: docs/PRACTICAL_6.md.
