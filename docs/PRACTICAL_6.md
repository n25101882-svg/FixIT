# Практична №6 — Hybrid MVP Database Migration

Повторна перевірка review [PR #3](https://github.com/n25101882-svg/FixIT/pull/3), **14 листопада 2026**, Codex Cloud. Гілка `feature/practical-06-hybrid-db`, основа develop (`a814a61`). [PR #2](https://github.com/n25101882-svg/FixIT/pull/2) лишається окремим відкритим Auth/React PR; його код сюди не переносився. Автоматичного merge немає.

## Виправлення review

1. Наступна міграція `20261114150000_review_snapshot_alignment` замінює guard через CREATE OR REPLACE FUNCTION: після INSERT заборонено змінювати title/city/category/description/budget, включно з NULL-переходами. Identity, price/master selection, history і переходи також захищені. Ті самі значення дозволені. Старий одноразовий backfill завершується раніше; review-міграція не переписує жодне старе замовлення/подію/timestamp.
2. Отримані ER-зображення та звіти №1–5 звірено з фізичною моделлю. Необґрунтовані mandatory prices прибрані: Service.priceEstimate / price_estimate, OrderResponse.proposedPrice nullable, Service.description nullable; додано optional CUSTOM budget. Старі суми не змінюються/не обнуляються. PostgreSQL enum category перейменовано на service_category без зміни значень. Інші відмінності явно пояснено нижче й у FIXIT_MVP_SPEC.md.
3. Виправлено план FIX-1: після інтеграції #2 потрібні **User + MasterProfile + перша Service в одній транзакції**, а не лише User для MASTER. Тут не додається Auth/реєстрація; перевірена тільки здатність БД до такої транзакції та rollback. Непогоджене скасування майстром/після початку робіт прибрано з команд; SQL теж забороняє IN_PROGRESS → CANCELLED відповідно до №4–5.

Initial і вже застосована Hybrid SQL **не редагувались**. SHA-256:

```text
20261109200000_init_database_schema
2c67b65cc6a5293b7a38683555f8b9caf0964d8d82b3f5e68f4dd482b8cab3ff
20261114130000_hybrid_mvp
dec3306fd4b73f81c06a570015c5aeb22cb353f46160b22dd4ed5d4e51132918
```

Усі зміни схеми після них — третя послідовна міграція, без reset/db push. П’ять business-таблиць: users, master_profiles, services, orders, order_responses. User і passwordHash контракт збережений.

## Фактично виконано

Node.js 24.22.1, npm 11.9.0, Prisma 7.10.1, TypeScript 5.9.3, PostgreSQL 18.6. Нові окремі loopback БД: `fixit_hybrid_review_test`, `fixit_hybrid_review_clean_test`, `fixit_hybrid_review_upgrade_test`; окрема shadow. Назви наведені для відтворення, credentials/URL не публікуються. `fixit_dev`, production, домашні Windows/WSL/БД не використовувались.

| Команда / перевірка | Фактичний результат |
| --- | --- |
| npm ci --no-audit --no-fund | 526 packages встановлено за lockfile, без зміни залежностей. Попередження про transitive glob deprecation; аудит вразливостей не заявляється. |
| npm run db:generate | Prisma Client 7.10.1 успішно згенеровано |
| npm run db:validate | Schema valid |
| npm run typecheck | Backend, seed, config і TS helpers без помилок |
| npm run er:validate | 5 таблиць, 7 FK; напрямки/політики й складена належність service/master валідні |
| npm run db:migrate, двічі | Застосовано всі **3** міграції; повторно No pending migrations |
| npm run db:seed, двічі | Успіх; fixtures 5 users / 2 profiles / 3 services / 3 orders / 2 responses. Jest і migration verifier окремо порівняли незмінність повторного seed |
| npm test | **4 suites, 82/82 passed, 0 failed, 0 skipped** (49 попередніх + 33 review-перевірки) |
| npm run build | TypeScript build успішний |
| npm run db:check | Реальне SQL-з’єднання, PostgreSQL 18.6, 5 таблиць і всі 3 міграції підтверджені |
| npm run test:migrations | Чиста БД, повторний deploy/seed, upgrade initial → Hybrid → review, snapshot/rollback і повторний deploy — PASS |
| prisma migrate diff --from-migrations prisma/migrations --to-config-datasource --exit-code | No difference detected, exit 0 |
| DBML ↔ фактичний PostgreSQL | Інтеграційний тест порівняв **усі колонки, типи, довжини й nullability** п’яти таблиць; 4 money-колонки decimal(10,2) |
| Запуск скомпільованого backend: node dist/server.js | /health/ready HTTP 200, database=up; POST /api/v1/orders HTTP 404; після smoke процес зупинено |
| Штатний Prisma engine / TLS | Installed schema engine d1b3f377… збігається з SHA-256 з офіційного binaries.prisma.sh; npm strict-ssl=true, немає TLS/checksum bypass/native override або Rust compilation |
| Незмінність застосованих SQL | Обидва SHA-256 збігаються з попереднім PR head; initial також із develop; migration verifier порівняв усі 3 applied checksums із файлами |

Перший прогін нових тестів мав одну помилку тестових даних: STANDARD уже мав категорію PLUMBING, а тест намагався встановити її повторно. Тест виправлено на справді іншу категорію ELECTRICAL; фінальний повний прогін — 82/82. Same-value updates окремо перевірені як дозволені. Jest друкує стандартне попередження Node experimental VM modules; це не пропущені тести. CI/Windows/Auth/frontend тести в цій гілці не виконувалися й PASS для них не заявляється.

### Що доведено тестами

- Прямі SQL та Prisma: створення STANDARD/CUSTOM допустиме; кожний title/city/category/description/budget UPDATE відхиляється саме guard-помилкою (SQLSTATE 23514). Після відмови весь рядок, updatedAt і statusHistory незмінні. Same-value update і нормальний status transition працюють.
- SQL та Prisma транзакції: перед забороненою зміною виконано інший валідний запис; після rollback він також не зберігається. Окремий DB-level тест створює MASTER User/Profile, навмисно ламає третій Service через price CHECK і підтверджує відсутність усіх трьох записів. Це передумова інтеграції FIX-1, **не тест готового register endpoint**.
- Непрайсована Service може створити STANDARD з NULL price snapshot; подальше встановлення ціни не переписує NULL. Текстова OrderResponse без суми вибирається в CUSTOM із NULL-safe перевіркою, не змінюючи budget.
- Збережена регресія №6: FK/UNIQUE/NOT NULL/enum/ролі, negative/overflow/NaN і zero/max ціни, shape, унікальна пропозиція, ownership, історія, seed і Express readiness. Конкурентна selection — дві справжні транзакції, один commit/один CONFLICT, один виконавець і одна ACCEPTED-подія.

Один concurrency-тест навмисно зберігає власну синтетичну заявку/пропозиції на кожний прогін у головній ізольованій *_test БД; решта мутацій відкочується. Повторні прогони збільшують ці синтетичні counts, не fixtures. Seed не переписує status/history/passwordHash/createdAt існуючих замовлень/користувачів.

### Перевірка міграцій без очищення даних

`scripts/verify-migrations.mjs` вимагає **дві нові порожні** локальні *_test БД CLEAN_DATABASE_URL/UPGRADE_DATABASE_URL, відмінні від головної TEST_DATABASE_URL. Непорожні БД відхиляє; reset/drop не виконує. Після прогону бази збережені для огляду. Для нового прогону потрібна нова порожня пара.

Чиста БД отримала всі 3 міграції, повторний deploy і повторний seed без зміни persisted state. Upgrade-БД спочатку отримала тільки незмінений initial і 5 синтетичних Orders зі всіма старими PENDING/ACCEPTED/IN_PROGRESS/COMPLETED/CANCELLED. Невідома категорія UNMAPPED_LEGACY викликала атомарну SQL-відмову Hybrid; після rollback записи/ціни збережені, fixture-категорію явно повернуто до початкової. Потім справжній Prisma deploy застосував незмінений Hybrid і окремо review-міграцію.

Перевірено всі старі ID/client/service links/описи/createdAt/statuses, точне cents → numeric/100 для 0, 1, 25000, 40000, 2147483647; 1 → 0.01 і max int → 21474836.47. Nullable bio зберіг NULL/текст. Рядки Orders/history до третьої міграції дорівнюють рядкам після неї (єдина додана колонка budget=NULL). Кожне legacy snapshot-поле захищене, попередній valid write транзакції відкочується. Повторний deploy не змінив жодного бізнес-рядка; всі applied checksums збігаються.

Backfill title/city/category/master бере відомі зв’язки **на час Hybrid міграції**. statusHistory legacy_migration містить спостережений тоді стан, час спостереження і legacyCreatedAt. Це не вигаданий час завершення/повна минула історія.

## Узгодження з ER та звітами №4–5

Звірено надані `Практична_робота_1_FixIT_оновлена.docx` (FIX-1, AC4–5), №4 (§3.1/FR-01/FR-07), №5 (§4.1–4.3) і ER-зображення. №4–5 прямо описують логічну модель, фізичні типи/обмеження уточнюються у №6. DOCX/картинку не редаговано і не комітимо. Публічність нижче означає цільове MVP, а не вже реалізований HTTP API. Повна продуктова специфікація: [FIXIT_MVP_SPEC.md](../FIXIT_MVP_SPEC.md#звірка-з-наданими-матеріалами).

| Відмінність | Рішення, призначення, інваріант | Публічність / потрібне уточнення ER/звіту |
| --- | --- | --- |
| ADMIN, isApproved | Залишити legacy без втрати даних; не використовувати як новий approval gate. ADMIN не обходить domain rules. | Внутрішні; ER позначає legacy, public register лише CLIENT/MASTER. |
| services.category | Залишити: поле прямо є в логічних моделях №4–5. Валідний enum, старі значення збережено. | Публічний фільтр послуг; додати пропущене поле на вихідній ER-картинці. |
| Назва enum category | Перейменовано в service_category через ALTER TYPE RENAME, без recast/заміни значень. | Узгоджено з ER; Prisma Category символ не змінений. |
| Обов’язкова Service.price | Виправлено на nullable price_estimate/priceEstimate. RENAME COLUMN не змінює суми; FIX-1 може створити першу послугу без ціни. | Optional орієнтир, не платіж; DBML відповідає ER, звіт має використовувати нову назву. |
| Обов’язковий Service.description | Виправлено nullable за ER. Для нової MASTER форми FIX-1 короткий опис усе одно required у серверному валідаторі інтеграції. | Розрізняти storage і form validation; не вигадувати тексти для старих рядків. |
| Відсутній Order.budget | Додано nullable decimal(10,2) для CUSTOM; STANDARD NULL. Nonnegative/finite, immutable після створення. | Optional бюджет з ER/FIX-5; не дубль priceAtOrder. |
| Обов’язковий OrderResponse.proposedPrice | Виправлено nullable: непорожній message достатній; задана сума exact/nonnegative. NULL-safe selection. | Необов’язкова пропозиція оцінки; аукціон/платежі не додаються; ER уточнена. |
| Додатковий priceAtOrder | Збережено всі старі ціни як optional immutable snapshot; не перетворюємо NULL на 0. | Історичний орієнтир, не зобов’язання оплати; додати колонку в фізичну ER/№6. |
| Додатковий statusHistory | JSONB append-only, DB-maintained; зберігає історію в межах п’яти таблиць. | Історія замовлення, actor ID не public authority; уточнити фізичну ER/№6. |
| masterId у логічних звітах | Фізично master_profile_id, Prisma masterProfileId; завжди FK до MasterProfile, не User. | Уніфікувати назву; JWT User.id → пошук власного профілю на сервері. |
| comment у №5 | Фізично message за ER-зображенням; непорожній immutable текст. | Той самий public зміст; додати mapping у №5. |
| display_name з картинки відсутній | Похідне від User.name; окремий бренд/псевдонім не задано у FIX-1. Не створювати друге джерело редагованого імені. | Public display name — User.name; на ER позначити derived, прибрати фізичний дубль. |
| MasterProfile.description nullable | Старий nullable bio перейменований, NULL/текст збережено. Нові MASTER в інтеграції мають надати опис. | Публічний опис, legacy optional; поправити NN на фізичній ER. |
| User.updated_at; Profile/Service created_at/updated_at | Не додаються: логічна модель/FIX-1 не вимагає окремого аудиту, старі часи невідомі. Order.updatedAt підтримується guard-ом. | Прибрати зайві фізичні timestamp-поля на вихідній ER; новий аудит потребує окремої вимоги/міграції. |
| completed_at з ER | Не дублювати: derived із реальної database-події COMPLETED; legacy-момент невідомий → NULL у майбутньому DTO. | Позначити derived/unknown legacy в ER; не видавати час backfill за completion. |
| Розміри name/email/title | Залишити 100/254/160 як чинний контракт; не обрізати існуючий title до 150. | Оновити 150/255/150 на картинці; майбутні API/forms використовують фактичні межі. |
| Bcrypt у №4 проти scrypt | Збережено безпечні salted self-described scrypt hashes/контракт PR #2; plaintext немає, конвертація без пароля неможлива. | Уточнити технічний алгоритм у №4; не переписувати дані/не вимагати password від користувачів у міграції. |

`docs/er-diagram.dbml` — актуальна фізична модель із цими рішеннями. Автотести порівнюють її колонки/типи/nullable з реальним SQL, migrate diff порівнює SQL chain із Prisma. Вихідні навчальні DOCX залишаються матеріалами вимог, не свідченням фактично виконаних задач або внеску учасників.

## SQL-обмеження

- 5 UUID PK; NOT NULL для required полів; 4 enum: user_role (ADMIN legacy), order_type, order_status, service_category.
- UNIQUE users.email, master_profiles.user_id, services(id,master_profile_id), order_responses(order_id,master_profile_id).
- 7 FK з ON DELETE RESTRICT. Складений Order(serviceId,masterProfileId) → Service(id,masterProfileId) гарантує STANDARD ownership; окремий master FK підтримує вибраний CUSTOM. Політики ON UPDATE описані в DBML.
- CHECK users_email_canonical_check; services_price_estimate_check, orders_price_at_order_check, orders_budget_check, order_responses_proposed_price_check (0..99999999.99, NULL допустимий, NaN заборонений); master_profiles_city_check, services_title_check, orders_text_check, order_responses_message_check; orders_history_check (непорожній array); orders_shape_check (правильна STANDARD/CUSTOM форма, STANDARD budget=NULL).
- Збережені role triggers: master_profiles_require_master_role, orders_require_client_role, users_protect_linked_role.
- orders_guard_hybrid: initial STANDARD PENDING/CUSTOM OPEN; незмінні content/identity/price/selected master; дозволений граф переходів; DB-maintained history/updatedAt. Звичайний SQL UPDATE теж не обходить snapshots. Одноразовий legacy backfill виконується до встановлення guard.
- order_responses_guard: parent FOR UPDATE, лише OPEN unassigned CUSTOM, immutable response, вибрану пропозицію видалити не можна. NULL-safe matching перевіряє вибраного майстра/ціну.

SQL задає мінімальні інваріанти/граф; права actor-а перевіряє сервер із даних БД. Transaction-local actorUserId — аудит, не JWT/RLS і не довіра до request body. JSON-історія лишається у Order, шоста таблиця/accepted-response flag не додається.

## План інтеграції з PR #2

1. Review #3 і merge власником у develop після приймання; автоматично не merge. Потім оновити основу `feature/practical-07-auth-skeleton` від develop. Зберегти всі 3 migrations і Hybrid schema, згенерувати client; не копіювати старий generated client або initial SQL поверх нових.
2. **FIX-1 не завершений у поточному #2:** MASTER register створює лише User. Допрацювати в #2 або окремому інтеграційному PR серверну бізнес-операцію з єдиною Prisma transaction: User → MasterProfile → перша Service. Із форми надходять name/email/password+confirmation, role, а для MASTER city/category/title/короткий опис; category для профілю й першої послуги з погодженого input. Ціна optional. Не підставляти вигадане місто/опис і не створювати профіль для CLIENT.
3. До транзакції перевірити поля/role allowlist CLIENT,MASTER, canonical email і password policy; зберігати тільки hash. UNIQUE email та обробка конкурентного дубліката обов’язкові. JWT/успішну відповідь видавати **після commit**; passwordHash не повертати. Чинні User.id/email/passwordHash/name/role/createdAt і user_role сумісні, ADMIN registration заборонений.
4. Інтеграційні endpoint-тести: MASTER success → рівно один пов’язаний User/Profile/Service; навмисна помилка третього запису → нуль усіх трьох, жодного success/token; невалідний профіль/email race → жодних orphan; CLIENT → лише User; ADMIN → відмова. Потрібно перевірити також умовні MASTER поля frontend. **У поточному PR перевірені тільки DB-level success/rollback передумови**, не цей endpoint/UI.
5. Після оновлення #2 розв’язати текстові конфлікти README.md, FIXIT_MVP_SPEC.md, package.json, зберігши Hybrid і Auth/frontend scripts/dependencies/suites, test:migrations та обидва набори environment examples (test DB/shadow і JWT/CORS). Не повертати cents/4-табличну модель через старий текст. Секрети/.env не переносити в Git.
6. Захищені order API згодом викликають наявні команди з actorId із перевіреного JWT/current User; OrderError → 400/403/404/409. Не приймати clientId/actor role як authority з body і не дублювати selection у контролері. FR-07 feed filtering за містом/категорією та відповідні product-тести — окрема наступна реалізація, не готовий тут каталог.
7. Після інтеграції: ізольований migrate deploy, generate/validate/typecheck/build, усі Hybrid+Auth suites, test:migrations на новій парі БД, frontend build/tests і browser E2E #2. Auth/React перевірки не оголошуються виконаними у #3.

Раніше статичний merge-tree preview проти #2 head `b83f564` показав конфлікти у README/spec/package.json. Це не merge/checkout/Auth integration; #2 не змінювався. Перелік конфліктів повторно уточнювати після оновлення #2, а не вирішувати їх додаванням Auth до цієї гілки.

## Windows QA, Cloud і реальні скріншоти

Повні команди встановлення/створення локальних тестових БД та запуску — [README](../README.md). Windows у цій задачі не запускався. Налаштуйте приватний .env за .env.example, окремі дозволені *_test DATABASE_URL/TEST_DATABASE_URL, окрему shadow; для test:migrations — дві нові порожні БД. Запустіть npm ci, db:generate, db:validate, db:migrate двічі, db:seed двічі, db:check, typecheck, er:validate, npm test, build, test:migrations. Не використовувати fixit_dev без окремої перевірки/backup, не запускати reset/db push.

Для справжнього скріншота міграцій: у PowerShell після налаштування приватного .env виконайте `npm run db:status` і повторний `npm run db:migrate`: має бути 3 applied / No pending migrations. Зніміть власний термінал, приховавши будь-які credentials. Для скріншота конфігурації відкрийте **.env.example**, не .env; не підставляйте реальні паролі/URL.

Для ручного snapshot QA під’єднайтесь psql/pgAdmin лише до своєї *_test БД, збережіть SELECT одного seeded Orders рядка, у транзакції спробуйте змінити title і переконайтеся в `Order content snapshots are immutable`; виконайте ROLLBACK і повторний SELECT. Або отримайте справжній лог автоматичного SQL/Prisma review suite через `npm test -- --runTestsByPath tests/review.integration.test.mjs`. Не редагуйте/не вигадуйте результати чи скріншоти.

Тестові БД після перевірок збережені для огляду. Seed має лише синтетичні @fixit.test акаунти без відомого спільного пароля. .env, credentials, generated client, node_modules, dist і приватні Cloud helpers не входять до PR. Публікація цього follow-up не виконує merge і не змінює #2.
