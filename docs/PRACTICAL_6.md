# Практична №6 — ER, PostgreSQL, Prisma migrations, Seeder

Дата перевірки: **9 листопада 2026 року**, Codex Cloud, Linux. Windows-команди наведені в README для відтворення, але на Windows у цьому чаті не виконувалися. До практичної №7 робота не переходила. Авторизація й бізнес-API не реалізовувалися.

## Результат

Фізична ER-схема — `docs/er-diagram.dbml`, модель — `prisma/schema.prisma`, initial migration — `prisma/migrations/20261109200000_init_database_schema/migration.sql`. Чотири бізнес-таблиці: users, master_profiles, services, orders. `_prisma_migrations` — службова таблиця Prisma, а не додаткова сутність MVP.

Міграція згенерована з моделі командою:

```bash
node node_modules/prisma/build/index.js migrate diff \
  --from-empty --to-schema prisma/schema.prisma --script \
  --output prisma/migrations/20261109200000_init_database_schema/migration.sql
```

**До першого застосування** до SQL додані BEGIN/COMMIT, CHECK для цін/email та три функції/triggers для ролей. Після застосування файл міграції не редагувався. Для наступних змін слід створювати нову міграцію. DBML містить ті самі поля, enum, індекси, FK та CHECK; рольові triggers позначені примітками, їхні тіла зберігаються в SQL. Схема та поведінка міграції перевірені проти PostgreSQL 18.

## Реально виконані перевірки

Робочий каталог: `/workspace/FixIT`. Перед командами завантажені локальні хмарні змінні з `/workspace/.fixit-dev/env.sh` і шлях до source-built Prisma engine з `/workspace/.fixit-dev/prisma-engine/env.sh`. Реальних значень паролів/connection strings у звіті немає.

| Команда / сценарій | Фактичний результат |
| --- | --- |
| `node --version`; `npm --version` | v24.22.1; 11.9.0 |
| `postgres --version`; `psql --version` | PostgreSQL 18.6 |
| `npm ci --no-audit --no-fund` | Чисте встановлення за package-lock успішне |
| `npm run db:generate` | Згенеровано Prisma Client 7.10.1 у src/generated/prisma |
| `npm run db:validate` | Prisma schema valid |
| `npm run er:validate` | DBML parses; 4 таблиці; 4 правильні FK та ON DELETE/UPDATE політики |
| `npm run typecheck` | Backend, Prisma config, seeder і TS-скрипти без помилок |
| Перший `npm run db:migrate` | Застосовано 20261109200000_init_database_schema |
| Повторний `npm run db:migrate` | No pending migrations to apply |
| `npm run db:status` | Database schema is up to date; одна міграція |
| `npm run db:seed`, двічі | Обидва запуски успішні; 5 users, 2 masterProfiles, 3 services, 2 orders |
| `npm run db:check` | PostgreSQL connection OK; database fixit_test; version 18.6 |
| `npm test` після npm ci | **2 suites, 25 tests passed, 0 skipped, 0 failed** |
| `prisma migrate diff --from-migrations prisma/migrations --to-config-datasource --exit-code` | No difference detected; exit 0; міграції повторно програно через окрему shadow DB |
| `npm start`, реальний HTTP-запит | GET /health/ready → 200, `{"status":"ok","database":"up"}` |
| Запуск dist/server.js з реальним закритим loopback DB-портом | Ненульовий exit; HTTP-порт не відкрито; пароль у логи не потрапив |
| Запит до _prisma_migrations | Один запис init_database_schema; finished_at заповнено; rolled_back_at NULL |
| SHA-256 migration.sql проти checksum у _prisma_migrations | Збігаються; застосований SQL не змінено |
| SQL COUNT після всіх тестів | users=5, master_profiles=2, services=3, orders=2 |
| `git check-ignore` | .env/.env.local/generated/node_modules/dist ігноруються; .env.example доступний для Git |
| Перевірка поточного локального пароля у файлах результату | Значення відсутнє в усіх 21 перевіреному файлі; сам пароль не виводився |
| `git diff --check` | Без whitespace-помилок |

Jest використовує Node ESM VM modules; Node друкує ExperimentalWarning. Це попередження, не пропущений тест. Перевірка readiness 503 у Jest моделює відмову DB callback; окремо сценарій startup вище використовував справжнє невдале TCP-підключення до закритого локального порту.

Інтеграційні тести перевірили:

- історію застосованої міграції;
- ідемпотентність seeder через порівняння повного стану таблиць, хешів, timestamp і цін/статусів замовлень;
- зв'язки CLIENT → Order → Service → MasterProfile → MASTER;
- UUID/timestamp/default PENDING; можливість повторного замовлення однієї послуги;
- незмінність priceAtOrderCents після зміни ціни Service;
- UNIQUE email, canonical lowercase, 1:1 профілю;
- рольові triggers для INSERT і зміни ролі користувача;
- FK, NOT NULL, enum, CHECK невід'ємної ціни, ON DELETE RESTRICT;
- HTTP 200/503 та відсутність бізнес-/auth-маршрутів;
- відмову тестової конфігурації від відсутніх, зовнішніх і не *_test URL, включно з параметрами підміни адреси.

Негативні сценарії виконують rollback; синтетичні fixtures залишаються для ручної перевірки. Зовнішні й production БД не використовувалися.

## Особливість Prisma engine у цій машині

Мережевий доступ до binaries.prisma.sh був відхилений. Натомість для поточної машини **зібрано реальний офіційний schema engine** з prisma/prisma-engines на commit `d1b3f377ca835d73fd50954a5e22128b9ebdd6b8`, який вимагає встановлена @prisma/engines 7.10.1. `schema-engine --version` підтвердив той самий commit. Збирання: Rust 1.97.1, `cargo build --release --locked -p schema-engine-cli --bin schema-engine`, максимум 4 jobs. Cargo перевіряв залежності; TLS і перевірки checksum не вимикалися. Шлях переданий через підтримуваний PRISMA_SCHEMA_ENGINE_BINARY.

Це локальний інструмент середовища поза Git. Для іншої машини потрібен доступ до binaries.prisma.sh для офіційного download або власне перевірене збирання того самого commit; збереження цього артефакту в новому опублікованому snapshot у цьому етапі не перевірялося. Окремий Cloud Bootstrap PR не створювався: зміни репозиторію є реалізацією №6.

## Як отримати справжні скріншоти

Скріншоти для здачі тут **не створювалися**. Нижче — відтворювані дії для реальних зображень, без вигаданих результатів.

1. **ER-діаграма.** Відкрийте dbdiagram.io у своєму браузері, створіть діаграму й вставте вміст `docs/er-diagram.dbml`. Перевірте чотири таблиці та зв'язки. Зробіть знімок вікна або експортуйте з реальної діаграми. Код DBML містить лише структуру та синтетичні пояснення, без паролів.
2. **Міграція.** У терміналі свого checkout виконайте `npm run db:migrate`, потім `npm run db:status`. Якщо міграція вже застосована, реальний результат — No pending migrations / schema up to date; це не помилка. Не скидайте БД заради кадру. Додатково покажіть SQL історії нижче. Для кадру саме першого застосування можна підготувати іншу порожню локальну *_test БД, встановити для неї конфігурацію та застосувати ту саму міграцію.
3. **Підключення і seeder.** Виконайте `npm run db:seed` двічі, `npm run db:check` та запит COUNT нижче. Зніміть фактичний вивід. За потреби додайте підсумок `npm test`.
4. **Конфігурація.** Відкрийте в редакторі саме `.env.example`, щоб у кадрі було видно ім'я файлу та CHANGE_ME. Не відкривайте реальний .env, env.sh або змінні процесу. Не виконуйте echo DATABASE_URL, Get-ChildItem Env:, printenv чи подібні команди.

У хмарі після source env.sh можна виконати:

```bash
psql -X -c 'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations;'
psql -X -c 'SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM master_profiles) AS master_profiles, (SELECT count(*) FROM services) AS services, (SELECT count(*) FROM orders) AS orders;'
```

На Windows відкрийте psql локально з паролем через запит, а не аргумент connection string:

```powershell
psql -h 127.0.0.1 -p 5432 -U fixit_test -d fixit_test
```

І виконайте ті самі SELECT у psql. Для знімків Windows використовуйте Win+Shift+S або інший звичайний засіб захоплення фактичного екрана. Назви можливих власних файлів: `06-er.png`, `06-migrations.png`, `06-seed.png`, `06-env-example.png`; наявність цих файлів тут не заявляється. Внесок інших учасників команди не приписується.
