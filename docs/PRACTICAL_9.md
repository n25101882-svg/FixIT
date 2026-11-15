# Практична №9 — CUSTOM orders: React → JWT API → PostgreSQL → React

Початкова реалізація перевірена **14.11.2026 у Codex Cloud**; review-виправлення й нові регресійні тести — **15.11.2026** (Europe/Kyiv). Гілка `feature/practical-09-orders` створена від актуальної develop `e04625567adb72e619f5e5a4592c754b694a586b`, яка містить merged PR #2 (Auth) і #3 (Hybrid). Результат — мінімальний повний вертикальний сценарій власних CUSTOM-заявок. PR направляється в develop, без автоматичного merge.

## Реалізація

- `src/orders/router.ts`: захищені GET/POST/DELETE під /api/v1, поточний User/CLIENT із БД, strict Zod, safe DTO та HTTP-помилки.
- `src/orders/service.ts`: наявні createCustom/transition і транзакційні правила **не змінені**; оновлений лише застарілий коментар про відсутність HTTP routes. Власність/граф/історія не дублюються в контролері.
- `src/app.ts`: підключення ordersRouter після Auth; CORS зберігає exact origins і дозволяє браузерний DELETE preflight.
- `frontend/src/orders.tsx`: /orders, форма, власний список, Loading/Empty/Error/Success, скасування та ручне оновлення. CLIENT-кабінет має «Мої заявки»; на MASTER-кабінеті цього переходу немає.
- API helper підтримує DELETE; UI/Auth із №7 збережені. Нових залежностей, таблиць, колонок чи міграцій немає.

Фізична схема — users, master_profiles, services, orders, order_responses з Prisma **7.10.1**. Schema/DBML і всі 3 застосовані міграції побайтово збігаються з develop. Їхні SHA-256:

```text
20261109200000_init_database_schema
2c67b65cc6a5293b7a38683555f8b9caf0964d8d82b3f5e68f4dd482b8cab3ff
20261114130000_hybrid_mvp
dec3306fd4b73f81c06a570015c5aeb22cb353f46160b22dd4ed5d4e51132918
20261114150000_review_snapshot_alignment
d2a98d6d5098a517ee55ac74500ec7ba13434f24e544551c5a0884ac6070e041
```

Auth core, password/JWT/config, lockfile, усі попередні **145 backend**, **12 frontend** та **5 Auth E2E** тестів збережені побайтово від develop. Жодних старих Order.address/userId/NEW у моделі/контракті: ці поля/значення лише відхиляються негативними тестами.

## HTTP-контракти

Для всіх трьох endpoint потрібний `Authorization: Bearer <реальний accessToken>`. authenticate перевіряє підпис/algorithm/issuer/audience/subject/exp, middleware читає поточну роль з БД. Ідентифікатор клієнта береться **лише з перевіреного JWT subject**, не з body/query. CLIENT middleware — дозвіл доступу до endpoint; наявний сервіс повторно перевіряє авторитетні ownership/role/state дані у транзакції.

### GET /api/v1/orders

**200** `{ "orders": [...] }` — лише clientId поточного CLIENT, `createdAt DESC, id DESC` для стабільних однакових дат. Новий CLIENT без записів отримує `[]`. Повертаються всі власні STANDARD/CUSTOM, включно зі скасованими/кінцевими станами, щоб зберегти історію. Query-параметри наразі не підтримані; спроба передати clientId/userId/filter → 400, доступу до чужих даних немає.

### POST /api/v1/orders

Content-Type application/json; приклад із **синтетичними** даними:

```json
{
  "title": "Синтетична проблема з водою",
  "description": "Синтетичний опис проблеми без персональних даних.",
  "city": "Тестоград",
  "category": "PLUMBING",
  "budget": "1250.50"
}
```

| Поле | Валідація |
| --- | --- |
| title | trim, 1–160 символів |
| description | trim, 1–4000 |
| city | trim, 1–100 |
| category | TECH_REPAIR / PLUMBING / ELECTRICAL / OTHER |
| budget | optional **string**, 1–8 integer digits, 0..99999999.99, максимум 2 дробові цифри після крапки |

Для відсутнього budget поле пропускається; NULL/number/empty string/negative/overflow/NaN/exponent/comma/3+ fractional digits відхиляються. Не застосовується Float/Number для money. Відсутній budget зберігається як NULL, нульова сума — окреме валідне `"0"`.

Strict schema відхиляє clientId/userId/address/type/status/serviceId/masterProfileId/statusHistory та інші зайві поля. createCustom сам встановлює CUSTOM/OPEN, відсутні service/master/priceAtOrder і DB-managed history. Після commit — **201 Created** `{ "order": {...} }`. DTO містить тільки Order scalar fields, ISO dates, nullable exact-two-decimal money strings і statusHistory; жодного passwordHash/User relation.

### DELETE /api/v1/orders/:id

UUID параметр, body не потрібний (порожній об’єкт дозволений, зайві поля — 400). Викликається наявний `transition(actorId,{orderId,status:CANCELLED})`. **Фізичного delete у HTTP endpoint немає.** CLIENT-власник може скасувати OPEN/PENDING/ACCEPTED відповідно до сервісу. Не можна скасувати IN_PROGRESS/COMPLETED/DECLINED/CANCELLED.

**200** `{ "order": {...status:CANCELLED...} }` — той самий id/createdAt/content/budget, одна додана history-подія CANCELLED із actorUserId/source=database. Рядок залишається у PostgreSQL і списку. Повторне скасування → 409 без нового history event чи зміни updatedAt. FOR UPDATE у сервісі серіалізує конкурентні запити: один 200, другий 409.

| Код | Коли |
| --- | --- |
| 400 | Невалідні/невідомі поля, UUID, query, money |
| 401 | Missing/invalid/expired JWT або видалений User |
| 403 | MASTER/ADMIN; спроба іншого CLIENT змінити чужу заявку; недозволений CORS origin |
| 404 | Валідний UUID, замовлення відсутнє |
| 409 | Недопустимий стан/повторне чи програне конкурентне скасування |
| 500 | Непередбачена помилка, redacted message без SQL/stack/секретів |

Межа JSON 16 KB та Auth rate-limit/JWT/CORS правила з №7 збережені. Не додаються public STANDARD creation, пропозиції/вибір майстра, каталог, рейтинг/Reviews, chat, payment або ADMIN UI.

## React і оновлення списку

/orders — у наявному ProtectedRoute; гість → /login. Початковий GET показує Loading, `[]` — Empty, помилки — Error із retry. GET 403 приховує CLIENT-форму; 401 очищує сесію й повертає login. Форми мають required/maxLength/pattern, accessible labels/field errors, заблоковані кнопки під час запиту.

Після POST/DELETE список змінюється з **повернутого committed запису**: нова заявка зверху, після CANCELLED картка залишається без кнопки скасування. Success/error не підміняють реальний результат. Поля форми скидаються тільки після успішного POST; invalid/network error зберігає введені дані. «Оновити» повторює GET без browser reload. Після 409 GET виконується автоматично, повідомлення про конфлікт зберігається; збій читання історії показується окремо з retry. Стара картка не дозволяє повторне скасування до успішної синхронізації. Форма не залежить від loading/мережевих/5xx помилок історії; лише 401/403 обмежують сесію/доступ.

Тексти статусів читабельні українською, budget відображається з точного рядка. Скасування у UI доступне лише до початку роботи; backend завжди є авторитетним. Історія повністю зберігається у БД/API, окремий timeline UI не додавався.

## Початкові перевірки — 14.11.2026

Середовище: Node **24.22.1**, npm **11.9.0**, Prisma **7.10.1**, TypeScript **5.9.3**, PostgreSQL **18.6**, Chromium **156.0.8078.79**. Нові окремі loopback БД `fixit_orders_test`, `fixit_orders_clean_test`, `fixit_orders_upgrade_test`, окрема shadow. `fixit_dev`, production, домашні Windows/WSL/БД/мережа не використовувались. Reset/db push не виконувались; TLS/checksum validation не вимикались.

| Команда / перевірка | Фактичний результат |
| --- | --- |
| npm ci --no-audit --no-fund | PASS, 635 packages за незміненим lockfile |
| npm run db:generate / db:validate | Client 7.10.1 generated / schema valid |
| npm run db:migrate / db:status | Всі 3 applied, database schema up to date |
| npm run typecheck / build | Backend/config/seed TypeScript — PASS; build також виконувався test/e2e scripts |
| npm run er:validate / db:check | 5 таблиць, 7 FK, PostgreSQL 18.6 SQL connection, всі 3 міграції — PASS |
| **npm test** | **198/198**, 7 suites, 0 failed/skipped: попередні **145** + **53 Orders API** |
| **npm run frontend:test** | **27/27**, 2 files: попередні **12** + **15 Orders UI** |
| npm run frontend:build | TypeScript і production Vite bundle — PASS |
| **npm run test:e2e** | **10/10**, старі **5 Auth** + **5 Orders**; реальні Express/PostgreSQL/Vite/Chromium |
| npm run test:migrations | PASS на двох **нових порожніх** clean/upgrade БД; всі 3 міграції, repeat deploy/seed, legacy upgrade, snapshot/rollback |
| prisma migrate diff --from-migrations prisma/migrations --to-config-datasource --exit-code | No difference detected, exit 0 |
| Git byte comparison з develop | Schema, DBML, всі 3 SQL, old tests, Auth core та package/lockfile незмінні; order service — тільки doc-comment change |
| Cleanup після tests/E2E | 0 тимчасових Auth/Orders accounts, 0 test-only constraints; залишено 5 users / 2 profiles / 3 services / 4 orders / 4 responses |

53 нові backend перевірки виконані на **реальній PostgreSQL** через Supertest/JWT: missing/invalid/expired/wrong-key token; MASTER/ADMIN forbid; deleted account; empty/own-only list/newest first; exact nullable budget; strict invalid/mass-assigned fields; owner-only soft cancellation, UUID 400/404, повтор 409, всі дозволені/заборонені статуси; history/snapshots/row count; concurrent cancellation; DELETE CORS preflight. Попередні 145 тестів не послаблені.

15 нових UI-тестів: protected route, Loading/Empty/Error/Success, create/cancel без reload, exact string/omitted budget, field/network errors із збереженням input, 401/403, retry/refetch після 409, disabled duplicates, terminal states. HTTP у цих unit-тестах mock; browser E2E використовує **справжні** API/БД.

Нові E2E: anonymous/guest 401/redirect; CLIENT A входить у браузері, з кабінету відкриває orders, отримує GET 200, створює CUSTOM через POST 201, бачить OPEN, підтверджує точні дані/actor history через SQL; CLIENT B не може скасувати чужий запис (403); UI DELETE 200 лишає рядок CANCELLED і другу history-подію, refetch 200 без main-frame navigation; повторний DELETE 409 не змінює запис. Окремо CLIENT B ізольований і створює без budget, MASTER не має CLIENT link/API permission, mobile 390×844 без horizontal overflow.

Migration verifier залишає clean/upgrade БД для огляду, ніколи не очищує непорожні БД. Старі 5 Orders/всі legacy statuses/IDs/links/descriptions/createdAt/exact cents 0/1/max integer збережені; unsupported category атомарно відхиляється; review snapshots/history/повторний deploy/seed незмінні; applied checksums збігаються. Для нового запуску потрібна нова порожня pair.

Orders/Auth/browser тести прибирають **лише власні синтетичні fixtures** через test-only ORM cleanup у правильному FK порядку; це не HTTP DELETE і не очищення всієї БД. Один попередній Hybrid concurrency-тест навмисно лишає свою synthetic заявку з двома пропозиціями після commit; тому final counts 4/4 відрізняються від seed 3 orders/2 responses. Історія цього тесту збережена, сторонні дані не видаляються.

Всі фінальні прогони успішні. Після першого PASS уточнено UI refresh, щоб він очищував застарілу помилку 409; повторні frontend/build/E2E також PASS. npm має успадковане glob deprecation warning; Jest — experimental VM modules, Playwright — color-env warning. Security audit/CI/Windows/manual screenshots як виконані не заявляються.

## Відтворення і Windows QA

Звичайні порти: backend **3000**, frontend **5173**, Windows PostgreSQL за вашим локальним конфігом (зразок 5432); Cloud test PostgreSQL **55432**. E2E самостійно запускає backend/frontend на **4100/5174** з випадковим environment JWT secret, не перевикористовує сторонні сервери.

1. Windows: Node 24/npm 11, Git, PostgreSQL 18 + psql. Створіть лише відсутні локальні `fixit_orders_test` і окрему shadow (root README), звичайна роль fixit_test. Пароль задавайте через psql prompt, не command-line URL. .env копіюйте з .env.example; заповніть тільки власними test credentials/JWT_SECRET. CLIENT пароль для QA власний синтетичний; seed passwords невідомі.
2. Для test:migrations — дві **нові порожні** `fixit_orders_clean_test`/`fixit_orders_upgrade_test`, окремі CLEAN_DATABASE_URL/UPGRADE_DATABASE_URL. Для повтору нова pair, без reset/drop. Повний setup SQL і PowerShell — [README](../README.md).
3. Із кореня репозиторію в PowerShell:

```powershell
npm ci
npm run db:generate
npm run db:validate
npm run db:migrate
npm run db:status
npm run typecheck
npm run er:validate
npm test
npm run frontend:test
npm run frontend:build
npm run test:migrations
npm exec playwright install chromium
npm run test:e2e
npm run dev
# В іншому терміналі: npm run frontend:dev
```

4. http://127.0.0.1:5173/register: зареєструйте двох власних synthetic CLIENT (passwordConfirmation обов’язковий), окремо MASTER з усіма профільними полями. CLIENT A: login → dashboard → «Мої заявки». Створіть із budget і без нього, перевірте список/стан OPEN, скасуйте й переконайтесь у CANCELLED без зникнення картки/reload. «Оновити» має зберегти CANCELLED із БД.
5. В іншій сесії ввійдіть CLIENT B — записів A немає. Через Network/Postman спроба DELETE UUID A з токеном B → 403; повторний DELETE від A → 409. MASTER API GET/POST/DELETE orders → 403; без JWT → 401. Секрети/tokens не копіюйте у Git/звіт. Refresh браузера очищує in-memory token, для QA знову ввійдіть.

Cloud у поточній машині: `bash /workspace/.fixit-dev/bin/pg.sh start`, `source /workspace/.fixit-dev/orders-env.sh`, далі npm-команди вище. Helper приватний, не Git; на іншій машині налаштуйте власні test bindings/Chromium. Для ручного dev потрібен environment/private .env JWT_SECRET. PostgreSQL URL тільки у prisma.config.ts; для migrate dev — окрема shadow. Жодних production-секретів або доступу до домашньої мережі.

## Три справжні докази №9

Це інструкції для **фактичного ручного QA**, не твердження, що screenshots уже зроблені. Windows/ручний браузер/pgAdmin тут не запускались. Використовуйте свої synthetic дані, приховуйте passwords/JWT_SECRET/Authorization/JWT/DB URL. Не редагуйте DOM, HTTP statuses чи SQL result для підміни результату.

### 1. Сторінка /orders

Ввійдіть CLIENT на http://127.0.0.1:5173, перейдіть з кабінету «Мої заявки». Створіть синтетичну проблему, дочекайтесь фактичного Success і картки OPEN («Відкрита»). У кадрі — URL **/orders**, форма, власна картка/title/city/category/budget/status. Додатковий кадр після скасування має показувати ту саму картку «Скасована». На Windows можна Win+Shift+S. Не підставляйте текст у DevTools.

### 2. Network HTTP 200/201

DevTools → Network → Fetch/XHR, фільтр orders. Натисніть «Оновити» → реальний **GET /api/v1/orders 200**. Створіть іншу synthetic заявку → **POST /api/v1/orders 201**, Response/Preview має містити справжній id/type=CUSTOM/status=OPEN і введені дані. Збережіть UUID із цієї відповіді для SQL-доказу. Покажіть method/URL/status та response на власних кадрах; можна додатково DELETE 200/повтор 409. **Сховайте Authorization value** і пароль; не експортуйте unredacted HAR із bearer credentials.

### 3. PostgreSQL: той самий UUID і збережена історія

Під’єднайтесь psql/pgAdmin до **своєї ізольованої fixit_orders_test**, ніколи fixit_dev. Наприклад `psql -h 127.0.0.1 -p 5432 -U fixit_test -d fixit_orders_test` (пароль через prompt). Підставте справжній UUID із Network замість placeholder, виконайте **read-only** SELECT:

```sql
SELECT o.id, u.email AS client_email, o.type, o.status,
       o.title, o.city, o.category, o.budget,
       o.service_id, o.master_profile_id, o.created_at,
       jsonb_pretty(o.status_history) AS history
FROM orders o
JOIN users u ON u.id = o.client_id
WHERE o.id = '<UUID_ІЗ_ВАШОЇ_РЕАЛЬНОЇ_HTTP_ВІДПОВІДІ>'::uuid;
```

До скасування: CUSTOM/OPEN, NULL service/master, ваш synthetic client/budget і перша OPEN-подія. Після UI DELETE повторіть той самий SELECT: **рядок лишився**, status=CANCELLED, content/createdAt збережені, history має OPEN і CANCELLED. У кадрі — виконаний SELECT та фактичний результат із тим самим id, без connection credentials/password_hash. Можливі файли: 09-orders.png, 09-network-200-201.png, 09-postgresql-order.png; тут вони не заявляються створеними.

## Відомі обмеження

- Тільки CLIENT own list/create CUSTOM/cancel. API пропозицій/вибору майстра, public STANDARD create, редагування/фізичне видалення, каталог/рейтинг/chat/payment/ADMIN UI поза scope.
- GET без пагінації/фільтрів; повертає всі власні записи. Інші сесії не push-оновлюються: потрібне «Оновити»; повного timeline UI немає, історія доступна в API/БД.
- Немає idempotency key для POST: кожний окремий успішний запит створює нову заявку; UI блокує повторну кнопку під час запиту. Повторний DELETE повертає 409 без нової події.
- In-memory token/refresh/logout і single-process Auth limiter залишені з №7; немає refresh/revocation. Orders endpoints не додають окремої квоти. Зовнішнє розгортання не виконувалось.
- Windows, ручні screenshots/Network/pgAdmin/Postman і CI не виконувалися в цій Linux-сесії. Автоматичні Chromium E2E — реальні; інструкції ручних доказів наведені чесно. PR не merge-иться автоматично.

## Review PR #4 — 15.11.2026, FIX-18

Виправлені всі три inline-зауваження в тій самій feature-гілці, окремим `fix:`-комітом із FIX-18. Нового PR немає. Схема Prisma/3 SQL-міграції, JWT/Auth architecture, backend та бізнес-правила src/orders/service.ts не змінені. FIX-17 (втрата in-memory сесії після F5) залишається окремою задачею, без localStorage/refresh token змін.

| Review | Виправлення та перевірки |
| --- | --- |
| REVIEW-01 | Native dialog із назвою/описом, safe default «Ні», явним Tab/Shift+Tab focus trap, Escape, кнопкою закриття й поверненням фокусу. «Ні»/закриття/Escape не запускають DELETE/GET; лише підтвердження запускає один DELETE. Unit-тести й справжній Chromium keyboard/HTTP-count/DB-history тест. Guard close events зберігає діалог у React StrictMode. |
| REVIEW-02 | Єдина loadOrders-функція автоматично виконує GET після 409. Конфлікт зберігається окремо від помилки GET, retry не стирає його; stale cancel action вимкнений до успішного читання. Unit-тести для CANCELLED/IN_PROGRESS, pending GET, HTTP 500/network, retry, 401/403; browser — реальне конкурентне скасування з PostgreSQL та контрольована 503 помилка GET. |
| REVIEW-03 / FIX-18 | Loading/помилка історії відокремлені від форми. Поля не перемонтовуються на retry; можна створити заявку при pending/500/503/network GET. 401 logout і 403 block збережені, у тому числі для POST/повторного GET. Версія/abort запиту не дозволяє пізньому старому GET затерти нову заявку або зняти блокування після 403. Unit- і browser-тести з реальними POST 201/SQL-записами. |

Форма використовує наявну автентифіковану сесію; успіх завантаження історії не є умовою її доступності. Явний 403 блокує форму й дії зі списком, сервер і надалі перевіряє CLIENT роль кожного запиту. Додаткових role claims чи змін AuthContext/JWT не внесено.

**Фактичний фінальний результат:**

| Команда | Результат |
| --- | --- |
| npm run typecheck | PASS |
| npm test | **198/198**, усі попередні backend cases, 7 suites, 0 failed/skipped |
| npm run frontend:test | **48/48**, попередні 27 + 21 review regression, 3 files |
| npm run frontend:build | PASS, TypeScript і Vite production build |
| npm run test:e2e | **15/15**, попередні 10 + 5 review regression, Chromium 156 |

Для наявних тестів лише додано обов’язковий крок підтвердження; старий 409-тест тепер перевіряє погоджену автоматичну синхронізацію замість ручного очищення conflict message. Жоден сценарій не видалений/пропущений. Backend 198 тестів, Auth frontend tests і Auth E2E файли не змінені.

У нових `frontend/src/orders.review.test.tsx` та `e2e/orders.review.spec.ts` перевірені всі три review-виправлення. Unit-шар використовує mock HTTP та мінімальну jsdom реалізацію dialog.open/close; focus trap, Escape і повернення фокусу перевірені у справжньому Chromium. Для browser network/503 помилок перехоплюються тільки GET запити історії; Auth, POST/DELETE і PostgreSQL залишаються реальними. Сценарій 409 отриманий реальною зміною стану через другий API-клієнт перед скасуванням зі stale UI, а не вигаданою відповіддю.

Регресійний Chromium-тест виявив вихід Tab за межі native dialog; додано явний Tab/Shift+Tab wrap, фінальний повний прогін успішний. У першому новому unit-прогоні helper використовував неіснуючий fireEvent.cancel; замінено стандартною cancel-подією, фінальні 48/48 PASS. Node VM modules / Playwright color warnings успадковані; security audit/CI/manual Windows screenshots не заявляються.

Нове середовище Cloud відновило доступ до workspace; PostgreSQL 18.6 запущено локально. Для backend/E2E створено **окрему нову fixit_orders_review_test** із трьома незміненими міграціями. Private helper `/workspace/.fixit-dev/orders-review-env.sh` поза Git задає DATABASE_URL/TEST_DATABASE_URL і локальний Chromium; actual credentials/connection strings не публікуються. fixit_dev/production/домашня мережа не використовувалися, reset/db push немає. test:migrations повторно в цьому fix не запускався: SQL-схема/міграції не змінені, їхній попередній результат вище є історичним.

Ручна додаткова QA: keyboard Enter відкриває dialog → «Ні» має focus; Tab/Shift+Tab лишаються всередині; Escape/«Ні»/× закривають без нового Network request і повертають focus. «Так» — один DELETE. Для конфлікту скасуйте той самий id іншим клієнтом API із тим самим owner-token, тоді підтвердіть stale UI cancellation: 409 → автоматичний GET, актуальний статус і збережене conflict message. Контрольована помилка GET повинна показати окремий retry, зберігши форму/введений draft; POST лишається доступним для CLIENT. При 401/403 — logout/block відповідно.

Відповіді на GitHub review threads не є approval і не закривають threads. PR залишається для повторного рев’ю Reviewer, без автоматичного merge. Ручні Windows/Postman screenshots не створювалися. Усі попередні обмеження MVP, включно з FIX-17, залишаються, крім погоджених тут UX/sync виправлень.
