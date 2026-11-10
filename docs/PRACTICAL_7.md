# Практична №7 — авторизація й app skeleton FixIT

Дата перевірок: **10 листопада 2026 року**. База — актуальна `develop` після merged PR #1 (№6), commit `a814a61`. Гілка реалізації: `feature/practical-07-auth-skeleton`. Посилання на єдиний PR надане в підсумковому звіті чату/GitHub; merge автоматично не виконується.

## Етап 1: хмарне середовище

GitHub API доступний: читальний GraphQL repository-запит успішний і повернув viewerPermission ADMIN. `binaries.prisma.sh` повернув HTTP 200 для офіційного checksum-файлу. Дозволи мережі застосовані (observations_current=true, network_policy.state=enforced). Авторизація GitHub відокремлена від доступності мережі; HTTP 401/403 самі по собі не вважаються мережевим блокуванням.

PostgreSQL збережена в окремому локальному кластері `/workspace/.fixit-dev/postgres/data`, запущена через pg.sh: **18.6**, `127.0.0.1:55432`, БД fixit_test та fixit_shadow. Production-секрети, домашній Windows/WSL/PostgreSQL і Docker не використовувалися.

На незміненій базі №6 виконані: npm ci, Prisma Generate/Validate, migrate deploy, typecheck, build і **25/25 тестів**. Міграція вже застосована, результат повторного deploy — No pending migrations to apply. Офіційний schema engine встановлений штатно в node_modules/@prisma/engines; source-built override не використовувався, Rust не запускався. TLS/checksum validation не вимикалися. Версії: Node.js 24.22.1, npm 11.9.0, Prisma 7.10.1.

## Реалізовані контракти

### Реєстрація

`POST /api/v1/auth/register`, Content-Type application/json:

```json
{
  "email": "synthetic-client@fixit.test",
  "password": "<власна локальна тестова фраза від 12 символів>",
  "name": "Синтетичний клієнт",
  "role": "CLIENT"
}
```

201 → `{ "user": { "id", "email", "name", "role" } }`. Email нормалізується (trim/lowercase), унікальність гарантує існуюча БД, зокрема при паралельних запитах. Password 12–128 символів, name 2–100. Role лише CLIENT/MASTER (за замовчуванням CLIENT); ADMIN, зайві/захищені поля й невалідні значення → 400. Повторний email → 409. MASTER не отримує штучний профіль із вигаданим city: його заповнення — майбутній крок.

Хеш: scrypt N=32768/r=8/p=3, сіль 16 випадкових байтів, ключ 64 байти. Пароль не зберігається відкритим текстом. Для login підтриманий також старий scrypt-формат seeder №6; самі seed-акаунти не мають відомих паролів.

### Вхід і поточний користувач

`POST /api/v1/auth/login`, body: `{ "email": "...", "password": "..." }`.

200 → accessToken, tokenType=Bearer, expiresIn=900 (типово), user із чотирма публічними полями. Неправильний пароль і відсутній акаунт отримують однаковий 401. Для невідомого акаунта також виконується scrypt-порівняння, щоб зменшити різницю часу відповіді.

`GET /api/v1/users/me`, header `Authorization: Bearer <accessToken>` → 200 з id/email/name/role. Missing/invalid/expired token, неправильні key/algorithm/audience, відсутній exp або видалений користувач → 401. PasswordHash ніколи не включається до user DTO.

JWT — HS256, issuer fixit-api, audience fixit-web, subject UUID користувача, перевірений exp. Secret тільки з environment, мінімум 32 байти; у репозиторії лише порожній зразок. Роль читається з БД при users/me. CORS приймає лише явно налаштовані origins локального frontend, без wildcard/cookies. Auth-запити обмежені до 30 за 15 хвилин на IP; JSON до 16 KB, помилки не повертають паролів, токенів, SQL чи stack traces.

Операційні /health та /health/ready збережені для регресії №6. Prisma schema, DBML і SQL-міграція №6 залишені без змін; нових таблиць/міграцій немає.

## Frontend

React + Vite + TypeScript, React Router; npm workspace frontend/ і спільний кореневий lockfile. /register дозволяє обрати CLIENT/MASTER, показує помилки й після успіху веде на /login. Login отримує access token, /dashboard виконує справжній users/me і показує email, ім’я та роль. Protected Route переводить гостя на /login; відповідь users/me 401 очищує сесію і повідомляє про повторний вхід. Logout очищує пам’ять.

Access token зберігається лише в пам’яті вкладки, без localStorage/sessionStorage. Refresh сторінки вимагає нового входу. UI адаптований для desktop і mobile; зовнішні шрифти/зображення не завантажуються. Каталог, замовлення, відгуки, платежі не реалізовувалися.

## Фактичні перевірки

| Перевірка | Результат |
| --- | --- |
| Етап 1, незмінена №6 | 25/25 тестів, Generate/Validate/typecheck/build успішні |
| Чистий npm ci за оновленим workspace lockfile | Успіх; штатний Prisma Engine без Rust |
| npm run db:generate / db:validate / typecheck / build | Успіх |
| npm test | **48/48**, 3 suites; включено всі 25 тестів №6 та 23 нові auth/HTTP/config тести |
| npm run frontend:build | TypeScript і production Vite bundle успішні |
| npm run frontend:test | **7/7**, форми, помилки, in-memory token, users/me, logout і expired-session redirect |
| npm run test:e2e | **5/5**, справжні Express/PostgreSQL + Vite + Chromium 156 |
| E2E CLIENT та MASTER | Реєстрація → login error → правильний login → users/me → dashboard → logout; без passwordHash |
| E2E додатково | Гість перенаправлений; duplicate email показаний; mobile 390×844 без горизонтального overflow |
| DB regression | PK/FK/UNIQUE/NOT NULL/enum/CHECK/role guards/delete policy/seed idempotence продовжують проходити |
| Schema/migration/DBML diff проти develop | Без змін |

Негативні JWT тести охоплюють missing, invalid, expired, wrong signature, HS384 замість HS256, wrong audience, missing exp, deleted account. Окремо перевірено ADMIN/mass-assignment rejection, CORS, 429 rate limit, malformed/oversized JSON та необхідність environment secret. Auth/browser тести створюють випадково іменовані синтетичні акаунти й прибирають лише їх; SQL-історія №6 збережена.

Frontend unit-тести використовують контрольовані HTTP-відповіді; browser E2E — реальні запити до ізольованої PostgreSQL. Windows та Postman у цьому середовищі не запускалися; їхні інструкції наведені для ручної QA, а не як виконані перевірки. Скріншот JWT у Postman не вигадувався. Для візуальної перевірки UI зняті справжні тимчасові Chromium captures; вони не додаються до Git як звітні докази користувача.

## Запуск і відтворення

Повні Windows/PostgreSQL/Cloud команди: [README.md](../README.md). Схему №6 застосовуйте `npm run db:migrate`, не db push/reset. Для dev потрібен власний локальний JWT_SECRET; фронтенду цей секрет не передається.

```bash
cd /workspace/FixIT
source /workspace/.fixit-dev/env.sh
bash /workspace/.fixit-dev/bin/pg.sh start
unset PRISMA_SCHEMA_ENGINE_BINARY PRISMA_MIGRATION_ENGINE_BINARY
export JWT_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("hex"))')"
npm ci
npm run db:generate
npm run db:migrate
npm run dev
# В іншій оболонці: npm run frontend:dev
```

Frontend: 127.0.0.1:5173, backend: 127.0.0.1:3000, PostgreSQL: 127.0.0.1:55432. VITE_API_URL за замовчуванням http://127.0.0.1:3000/api/v1; CORS_ORIGINS містить точні localhost/127.0.0.1:5173. Не додавайте JWT_SECRET/DATABASE_URL до frontend VITE_* змінних.

Перевірки (явний TEST_DATABASE_URL — тільки локальна *_test БД):

```bash
npm run typecheck
npm test
npm run frontend:build
npm run frontend:test
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
npm run test:e2e
```

E2E запускає власні процеси на 4100/5174 та передає випадковий secret через environment, а не код. На Windows встановіть Playwright Chromium через `npm exec playwright install chromium` і не задавайте Linux executable path. Trace/video не записуються, щоб не зберігати bearer credentials.

## Реальний скріншот JWT у Postman

1. Запустіть локальний backend із власним випадковим JWT_SECRET. Створіть у Postman локальне environment: baseUrl=http://127.0.0.1:3000, email=власний унікальний синтетичний @fixit.test, password=локальна тестова фраза 12–128 символів. Password позначте як Secret, не публікуйте environment export зі значеннями.
2. POST `{{baseUrl}}/api/v1/auth/register`, Body → raw → JSON:

```json
{
  "email": "{{email}}",
  "password": "{{password}}",
  "name": "Синтетичний користувач",
  "role": "CLIENT"
}
```

Очікуйте 201; при повторному email — реальний 409, використайте свій інший синтетичний email або увійдіть в уже створений акаунт.

3. POST `{{baseUrl}}/api/v1/auth/login`, Body JSON `{ "email": "{{email}}", "password": "{{password}}" }`. Натисніть Send. Реальний результат — 200 із accessToken, tokenType, expiresIn та user. Зробіть знімок саме фактичної відповіді в Postman. Не показуйте значення JWT_SECRET або пароля. Для спільного звіту використовуйте лише локальний синтетичний токен; перед публікацією дочекайтеся його завершення або змініть dev-key. Не підставляйте намальований/чужий JWT.
4. Збережіть accessToken як локальну Secret-змінну Postman. GET `{{baseUrl}}/api/v1/users/me`, Authorization → Bearer Token → `{{accessToken}}`. Перевірте 200 і лише id/email/name/role. Без Authorization отримайте фактичний 401.

## Реальний скріншот /dashboard

1. Запустіть frontend і backend за README, відкрийте http://127.0.0.1:5173/register у звичайному браузері.
2. Зареєструйте власні синтетичні CLIENT або MASTER дані, увійдіть через /login. Не використовуйте невідомі паролі seed-акаунтів №6.
3. На /dashboard дочекайтеся завершення запиту users/me: мають бути видимі email, ім’я, роль і кнопка «Вийти». Зробіть справжній screenshot браузера; URL у кадрі має відповідати /dashboard. На Windows можна Win+Shift+S. Для mobile — реальний responsive viewport 390×844 у DevTools.
4. Натисніть «Вийти» та перевірте перенаправлення /dashboard → /login. Не оновлюйте сторінку перед кадром: token навмисно лише в пам’яті, refresh вимагає повторного входу.

Можливі власні назви файлів: 07-postman-jwt.png, 07-dashboard.png. Наявність цих звітних файлів тут не заявляється; вкладені ілюстрації чи скріншоти не фабрикуються.

## Межі цього етапу

Немає refresh tokens, server-side token revocation, password reset/email verification, каталогу/замовлень/відгуків/платежів. Logout локальний; отриманий JWT може діяти до exp. Зовнішнє розгортання потребує HTTPS і окремого керування секретами/origins; цей PR не є deployment. Rate limiter — in-memory для одного процесу. ADMIN публічно не створюється. Схему та початкову міграцію №6 не змінено. Після PR робота зупиняється без merge.
