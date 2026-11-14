# Практична №6 — Hybrid MVP Database Migration

Перевірено **14 листопада 2026 року** у Codex Cloud. Гілка `feature/practical-06-hybrid-db` вже існувала від develop (`a814a61`); робота виконана в ній. PR #2 (`feature/practical-07-auth-skeleton`) залишається окремим відкритим Auth/React PR. Цей результат не містить Auth/React і не merge-иться автоматично.

## Результат

П’ять узгоджених таблиць: users, master_profiles, services, orders, order_responses. DBML, Prisma schema й фактична PostgreSQL мають однакові колонки; `npm run er:validate` перевіряє 7 FK, зокрема складену належність service/master для STANDARD.

Initial migration `20261109200000_init_database_schema/migration.sql` **не змінена**. Її SHA-256:

```text
2c67b65cc6a5293b7a38683555f8b9caf0964d8d82b3f5e68f4dd482b8cab3ff
```

Додана `20261114130000_hybrid_mvp`: транзакційне оновлення enum, нові Order поля/OrderResponse, точний cents → decimal(10,2), заповнення старих STANDARD, CHECK та triggers. Невідомі старі категорії не губляться через автоматичне OTHER: міграція відмовляється й вимагає явного виправлення. NULL/текст старого bio зберігаються у nullable description. Нова category профілю виводиться з однієї категорії послуг або OTHER за відсутності відомого однозначного значення.

ID, client/service links, опис, створення, всі старі статуси й ціни Orders збережені. Title/city/category/master — поточні дані наявних зв’язків на час backfill, а не реконструйовані історичні дані. statusHistory містить одне спостереження legacy_migration на **час міграції**, разом з відомим legacyCreatedAt; повна стара історія не вигадується. createdAt не змінюється.

## Фактично виконано

Середовище: Node.js 24.22.1, npm 11.9.0, Prisma 7.10.1, PostgreSQL 18.6. Використані окремі дозволені loopback *_test БД та окрема shadow. `fixit_dev`, production, домашні PostgreSQL/WSL і production-секрети не використовувалися. Немає reset/db push, TLS/checksum bypass або компіляції Rust.

| Команда / перевірка | Результат |
| --- | --- |
| npm ci --no-audit --no-fund | Чисте встановлення за наявним lockfile успішне; нових Auth-залежностей немає |
| npm run db:generate | Prisma Client 7.10.1 згенеровано |
| npm run db:validate | Schema valid |
| npm run typecheck | Backend, seed, config і TS helpers без помилок |
| npm run er:validate | 5 таблиць, 7 FK; правильні напрямки та policies |
| npm run db:migrate, двічі | Обидві послідовні міграції застосовані; повторно No pending migrations |
| npm run db:seed, двічі | Успіх; fixtures 5 users / 2 profiles / 3 services / 3 orders / 2 responses, без переписування історії |
| npm test | **3 suites, 49/49 passed, 0 skipped, 0 failed** |
| npm run build | TypeScript build успішний |
| npm run db:check | SQL connection до PostgreSQL 18.6, 5 таблиць та Hybrid migration підтверджені |
| npm run test:migrations | Clean deploy/seed/rerun та upgrade старих fixtures успішні; подробиці нижче |
| prisma migrate diff --from-migrations prisma/migrations --to-config-datasource --exit-code | No difference detected, exit 0 |
| Реальний npm start + GET /health/ready | HTTP 200 з database=up на Hybrid test БД; процес після перевірки зупинено |
| POST /api/v1/orders без Auth | 404: незахищені мутації не відкриті |
| Prisma/DBML/PostgreSQL column comparison | Збігаються всі 5 таблиць; 3 money колонки мають precision=10/scale=2 |
| Initial migration bytes/checksum | Збігаються з develop та історією міграцій |

`test:migrations` використовує **дві окремі порожні** CLEAN_DATABASE_URL/UPGRADE_DATABASE_URL, відмінні від основної test БД. Воно не очищує існуючі БД, а зупиняється, якщо вони не порожні. Після запуску результати збережені для огляду; для нового прогону надайте нову пару порожніх *_test БД.

Перевірка upgrade спочатку застосувала тільки незмінений initial, створила синтетичні старі дані й п’ять Orders зі старими PENDING/ACCEPTED/IN_PROGRESS/COMPLETED/CANCELLED. Після Hybrid перевірені всі ID, зв’язки, описи, timestamp і точні значення 0, 1, 25000, 40000 та 2147483647 копійок. Окремо доведено 1 → 0.01 і 2147483647 → 21474836.47 без float. Програно атомарну SQL-відмову на UNMAPPED_LEGACY, після rollback жодний запис/ціна не втрачений; категорію явно повернуто до початкової для реального migrate deploy. Повторний deploy не змінив даних, initial checksum незмінний.

49 Jest/Supertest тестів охоплюють FK/UNIQUE/NOT NULL/enum/CHECK/ролі/ціни (negative, overflow, NaN, zero/max), STANDARD та CUSTOM shape, один offer/profile, неможливість offer на STANDARD/закриту заявку, незмінність snapshot/history, законні переходи й ownership. Конкурентна selection використовує дві справжні транзакції: одна commit, друга CONFLICT; один master і лише одна ACCEPTED-подія. Вибрану пропозицію не можна видалити. Цей concurrency-тест залишає одну власну синтетичну історію в ізольованій *_test БД; це не mock і не дані користувачів. Решта мутацій тестів використовують rollback. Кількості fixtures не слід плутати з глобальним числом записів після domain-тестів.

## SQL-обмеження

- PK UUID у п’яти таблицях; обов’язкові поля NOT NULL, чотири enum: user_role (legacy ADMIN), order_type, order_status, category.
- UNIQUE users.email, master_profiles.user_id, services(id,master_profile_id) та order_responses(order_id,master_profile_id).
- 7 FK з RESTRICT видалення. Складений Orders(serviceId,masterProfileId) → Service(id,masterProfileId) виключає чужого майстра для STANDARD. Окремий master FK підтримує вибраний CUSTOM.
- CHECK canonical email; ціни 0..99999999.99 (без NaN); непорожні city/title/description/message; правильна STANDARD/CUSTOM форма; JSON statusHistory — непорожній array.
- Початкові role triggers збережені: master_profiles_require_master_role, orders_require_client_role, users_protect_linked_role.
- orders_guard_hybrid: initial PENDING/OPEN, дозволені переходи, незмінність type/client/service/price та вибраного master, DB-maintained history/updatedAt.
- order_responses_guard: parent FOR UPDATE, тільки OPEN unassigned CUSTOM, immutable offer, заборона видалення вибраної пропозиції.

Власність і право дії додатково перевіряє **серверний** src/orders/service.ts за actor з БД. SQL context actorUserId є аудитом, а не механізмом автентифікації. JSON-історія збережена всередині Order: шоста таблиця не додана. Немає дубльованого accepted-response flag.

## План інтеграції з PR #2

1. Спочатку review цього PR і merge власником у develop; автоматичного merge немає. Потім оновити основу feature/practical-07-auth-skeleton від develop, не cherry-pick-ати стару initial migration чи старий generated client.
2. User/id/email/passwordHash/name/role/createdAt та user_role не змінені, тому auth DTO, password verification та JWT subject з PR #2 залишаються сумісними. ADMIN не додавати у public register enum; MASTER registration як і раніше створює User, а не профіль із вигаданим city.
3. Зберегти Hybrid schema/дві migrations і regenerated Prisma Client. Об’єднати npm scripts з workspaces/dependencies PR #2, залишити test:migrations. В env example зберегти обидва набори: локальні migration-test bindings і JWT/CORS налаштування. Private .env/секрети не переносити в Git.
4. Погодити README/FIXIT_MVP_SPEC із двома етапами; не повертати cents або чотиритабличну схему через старі фрагменти документації.
5. У майбутньому підключати order HTTP routes тільки після JWT middleware: actorId з перевіреного subject/current User, не з body. Мапити OrderError у 400/403/404/409. Не дублювати транзакційну логіку selection в контролері.
6. Після інтеграції виконати migrate deploy на ізольованій test БД, Generate/Validate/typecheck/build, Hybrid+Auth тести, frontend build/tests та browser E2E PR #2. Ці Auth/React перевірки **не оголошуються виконаними в поточній гілці**.

Статичний `git merge-tree` із фактичним head PR #2 (`b83f564`) показав текстові конфлікти лише у FIXIT_MVP_SPEC.md, README.md та package.json. Це обчислення merge-плану без checkout/merge гілок; Auth до цього head не додано. .env.example автоматично поєднується, але набір bindings потрібно перевірити вручну. Після розв’язання цих трьох файлів усе одно потрібні повні інтеграційні перевірки з пункту 6.

## Межі та відтворення

README містить Cloud/Windows команди. Windows у цій задачі не запускався. Initial застосований SQL не редагувався; нові зміни у подальшому оформлювати наступними міграціями. Дані з невідомими старими категоріями/порожніми required metadata потребують свідомого виправлення перед deploy — не автоматичного втрачання/вигадування значень. Ціна 3+ дробових знаків відхиляється сервером; звичайна PostgreSQL coercion до decimal не є API-валідатором.

Скріншоти, CI-результати, внесок учасників не вигадувалися. PR #2/його гілка не змінювалися. Секрети, .env та реальні рядки підключення до PR не додаються.
