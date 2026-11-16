# FixIT — менше турбот, більше дому

![Версія](https://img.shields.io/badge/MVP-v1.0.0-50734f) ![Хостинг](https://img.shields.io/badge/Render-Live-38805b?logo=render) ![Стек](https://img.shields.io/badge/Node.js-24-43853d?logo=nodedotjs) ![База даних](https://img.shields.io/badge/PostgreSQL-18-336791?logo=postgresql)

> Навчальний командний MVP із дисципліни **«Проєктний практикум»**: платформа для клієнтів, яким потрібна допомога вдома, та локальних майстрів, які надають послуги.

**[🌐 Відкрити FixIT](https://fixit-web-o6v6.onrender.com)** · **[💻 Код релізу v1.0.0](https://github.com/n25101882-svg/FixIT/tree/release/v1.0.0)** · **[📋 Завдання в Jira](https://coderank.atlassian.net/jira/software/projects/FIX/boards/34)**

**Актуальність:** 16 листопада 2026 року. На цей момент вебзастосунок було розгорнуто на Render, а основний сценарій CUSTOM перевірено через браузер на реальному сервері. Доступність безкоштовного хостингу згодом може змінитися. Код репозиторію приватний: для його перегляду або клонування потрібен доступ GitHub.

## Про проєкт

**FixIT** — вебмаркетплейс побутових послуг. Клієнт може знайти конкретного майстра в каталозі й замовити його готову послугу (**STANDARD**) або опублікувати власну проблему (**CUSTOM**), отримати пропозиції від відповідних майстрів та обрати виконавця. Майстер керує своїми послугами й виконує призначені замовлення. Історія та статуси зберігаються в PostgreSQL.

### Можливості MVP

| Для клієнта (CLIENT) | Для майстра (MASTER) |
| --- | --- |
| Реєстрація, вхід, профіль та вихід | Реєстрація з профілем і першою послугою |
| Каталог, пошук за містом та категорією | Редагування профілю і власних послуг |
| STANDARD-заявка на готову послугу | Прийняття або відхилення STANDARD-заявки |
| CUSTOM-заявка з описом, містом, категорією і бюджетом | Стрічка відповідних CUSTOM-заявок і надсилання пропозиції |
| Вибір майстра з пропозицій | Початок і завершення призначеної роботи |
| Історія замовлень, деталі та статуси | Призначені заявки, деталі та історія статусів |

**У Post-MVP (не реалізовано у v1.0.0):** онлайн-оплата, рейтинги/відгуки про майстрів, вбудований чат, OAuth, фото та геолокація. [FIX-19 у Jira](https://coderank.atlassian.net/browse/FIX-19).

## Технологічний стек та архітектура

| Частина | Технології |
| --- | --- |
| Frontend | React 19, TypeScript, React Router 7, Vite 8, CSS |
| Backend | Node.js 24, Express 5, TypeScript, Zod |
| База даних | PostgreSQL 18, Prisma ORM 7.10.1 |
| Авторизація | scrypt для паролів, JWT access token, ротація HttpOnly refresh-cookie |
| Інфраструктура | GitHub, Jira, Render (один Node Web Service + окрема PostgreSQL) |
| Якість | Jest, Vitest, Playwright, Prisma Migrate |

```mermaid
flowchart LR
    A[Браузер CLIENT / MASTER] --> B[React + Vite]
    B -->|/api/v1| C[Node.js + Express]
    C --> D[Prisma ORM]
    D --> E[(PostgreSQL 18)]
```

У хмарі React та API працюють **на одному HTTPS-origin**: [https://fixit-web-o6v6.onrender.com](https://fixit-web-o6v6.onrender.com). На локальній машині frontend і backend запускаються окремо. Структура даних: 5 бізнес-таблиць (`users`, `master_profiles`, `services`, `orders`, `order_responses`) і технічна `auth_sessions`. [ER/DBML](https://github.com/n25101882-svg/FixIT/blob/release/v1.0.0/docs/er-diagram.dbml).

## Інструкція з локального розгортання (Windows PowerShell)

### 1. Вимоги

- Git і доступ до приватного репозиторію FixIT.
- **Node.js 24.x** та **npm 11.x**.
- **PostgreSQL 18** і `psql` у PATH (або виконання SQL через pgAdmin).
- Два локальні порти: **3000** (Express) та **5173** (Vite).

### 2. Отримайте код релізу

```powershell
git clone https://github.com/n25101882-svg/FixIT.git
cd FixIT
git switch release/v1.0.0
node --version
npm --version
```

> **Чому `git switch` обов'язковий?** На дату документації стандартна гілка `main` ще містила лише початковий каркас. Робоча версія з кодом, міграціями та `package.json` — у `release/v1.0.0`. Це не команда злиття гілок.

### 3. Створіть окрему локальну тестову БД

Не використовуйте production Render або чужі/наявні бази. У PostgreSQL під адміністратором створіть **нову** роль і **нову порожню** БД (імена нижче — приклад, виконуйте лише якщо вони ще не існують):

```sql
CREATE ROLE fixit_docs LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
-- У psql окремою командою задайте приватний пароль:
\password fixit_docs
CREATE DATABASE fixit_docs_test OWNER fixit_docs;
```

Не вставляйте пароль у SQL-файл, Git або скриншоти. Якщо імена зайняті, виберіть нові: ім'я БД має закінчуватися на `_test`.

### 4. Налаштуйте `.env` та встановіть залежності

```powershell
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
npm ci --include=dev
```

Вставте згенерований секрет тільки у приватний `.env`. Приклад потрібних параметрів (усі значення `CHANGE_ME` потрібно замінити; пароль БД у URL має бути percent-encoded, якщо містить спеціальні символи):

```dotenv
DATABASE_URL="postgresql://fixit_docs:CHANGE_ME@127.0.0.1:5432/fixit_docs_test?schema=public"
TEST_DATABASE_URL="postgresql://fixit_docs:CHANGE_ME@127.0.0.1:5432/fixit_docs_test?schema=public"
JWT_SECRET="CHANGE_ME_GENERATED_PRIVATE_SECRET"
HOST=127.0.0.1
PORT=3000
NODE_ENV=development
TRUST_PROXY_HOPS=0
SERVE_FRONTEND=0
JWT_TTL_SECONDS=900
CORS_ORIGINS="http://127.0.0.1:5173,http://localhost:5173"
SHADOW_DATABASE_URL=""
```

Решту прикладів дивіться у [`.env.example`](https://github.com/n25101882-svg/FixIT/blob/release/v1.0.0/.env.example). Файл `.env` має залишитися поза Git. Не додавайте `DATABASE_URL`, `JWT_SECRET`, паролі чи токени у змінні `VITE_*`.

### 5. Міграції та запуск

```powershell
npm run db:generate
npm run db:validate
npm run db:migrate
npm run db:status
npm run dev
```

Backend працюватиме за адресою **http://127.0.0.1:3000**. У **другому** терміналі з кореня репозиторію виконайте:

```powershell
npm run frontend:dev
```

Відкрийте **http://127.0.0.1:5173**. Контрольні URL: `http://127.0.0.1:3000/health` та `http://127.0.0.1:3000/health/ready`. Не змішуйте `localhost` і `127.0.0.1` при роботі з refresh-cookie. Для звичайного запуску база може спочатку бути порожньою: зареєстрований MASTER одразу створює свою першу послугу.

**За потреби:** `npm run db:seed` наповнює тільки **вашу окрему локальну тестову БД** демонстраційними записами. Не запускайте seed, `db push`, `migrate reset` або тести з очищенням даних проти production чи існуючої робочої БД.

### 6. Як перевірити код

```powershell
npm run typecheck
npm test
npm run frontend:test
npm run frontend:coverage
npm run frontend:build
```

Для браузерних E2E потрібен Chromium та **окреме явно авторизоване тестове середовище**:

```powershell
npm exec playwright install chromium
# Після налаштування приватної *_test БД:
npm run test:e2e
```

Повний `release:verify` призначений для ізольованого локального тестового середовища й не запускається проти Render. Впевненість у цих інструкціях ґрунтується на перевірці команд та конфігурації репозиторію; **незалежний clean-install на іншому ПК ще потрібно підтвердити**.

## Посібник користувача (User Guide)

### Гість

1. Відкрийте [FixIT](https://fixit-web-o6v6.onrender.com) та перейдіть до **Каталогу** (`/catalog`).
2. Знайдіть майстра або послугу за категорією/містом; відкрийте публічну картку майстра (`/masters/:id`).
3. Для створення замовлення зареєструйтеся або увійдіть.

### Клієнт — CLIENT

1. Натисніть **«Створити акаунт»**, виберіть роль **Клієнт**, заповніть ім'я, email, пароль і підтвердження. Після реєстрації увійдіть (`/login`).
2. Відкрийте **«Мої заявки»** (`/orders`) із кабінету (`/dashboard`).
3. **STANDARD:** у каталозі натисніть **«Замовити послугу»**, перевірте пропозицію майстра й підтвердьте замовлення. Початковий статус — `PENDING`.
4. **CUSTOM:** у «Моїх заявках» заповніть назву проблеми, опис, місто, категорію та необов'язковий бюджет. Після створення заявка має статус `OPEN`.
5. Для CUSTOM відкрийте **«Переглянути пропозиції»**, ознайомтеся з повідомленнями майстрів і натисніть **«Обрати майстра»**.
6. Переглядайте деталі та історію статусів. Скасування доступне лише до початку виконання робіт.

### Майстер — MASTER

1. Під час реєстрації виберіть **Майстер**. Вкажіть місто, категорію, опис профілю і першу послугу.
2. У кабінеті (`/dashboard`) відкрийте **«Профіль і послуги»** (`/master/services`) для керування інформацією та активністю послуг.
3. У **«Заявки для майстра»** (`/master/orders`) переглядайте CUSTOM-заявки, що відповідають місту та категорії. Надішліть текстову пропозицію.
4. Після вибору клієнтом заявка з'явиться серед призначених. Натисніть **«Розпочати роботу»**, а потім **«Завершити роботу»**.
5. Для STANDARD-заявок спочатку виберіть **«Прийняти»** або **«Відхилити»**. Завершені заявки та історія статусів залишаються доступними.

**Вихід:** у власному кабінеті натисніть **«Вийти»** — застосунок поверне вас на сторінку входу. Після F5 дійсна сесія може відновитися через захищений refresh-cookie; це нормальна поведінка.

## Production-розгортання (Render)

Конфігурація зберігається в [`render.yaml`](https://github.com/n25101882-svg/FixIT/blob/release/v1.0.0/render.yaml): Node.js 24, **один Web Service** для Express + React, окрема **PostgreSQL 18**, регіон Frankfurt, Free-плани, автоматичні деплої вимкнені. Релізна гілка — `release/v1.0.0`.

Серверні секрети зберігаються тільки в **Render Environment Variables**: `DATABASE_URL` на приватну PostgreSQL, згенерований `JWT_SECRET`; `CORS_ORIGINS` має дорівнювати **фактичному HTTPS-origin** сервісу (`https://fixit-web-o6v6.onrender.com`). `VITE_API_URL=/api/v1`, `SERVE_FRONTEND=1`, `NODE_ENV=production`, `TRUST_PROXY_HOPS=1`. Значення `PORT` призначає Render. Не копіюйте приватні конфігурації в README чи клієнтський код.

Команда запуску виконує перевірку оточення та `prisma migrate deploy` перед стартом сервера; існуюча production-БД не повинна скидатися. Докладний порядок, обмеження й відновлення: [Deployment & rollback](https://github.com/n25101882-svg/FixIT/blob/release/v1.0.0/docs/DEPLOYMENT_RENDER.md).

**Примітка щодо безкоштовного тарифу:** для створеної 16.11.2026 бази Render була вказана дата закінчення безкоштовного періоду **16.12.2026**. Перед захистом або демонстрацією перевірте її доступність; хостинг не гарантує безстрокової роботи.

## Тестування та відомі обмеження

- За звітом Codex Cloud для релізної кандидатури: **651 backend-тест, 287 frontend-тестів і 43 Chromium E2E** пройшли. Це результати ізольованого тестового середовища, не тотожні перевіркам Render.
- 16.11.2026 production-деплой Render перейшов у `Live`; вручну перевірено реєстрацію та вхід CLIENT, створення CUSTOM, пропозицію MASTER, вибір виконавця, початок/завершення роботи й історію статусів.
- Виявлений під час першого запуску незаповнений `CORS_ORIGINS` виправлено через налаштування середовища; код бізнес-логіки не змінювався.
- Поза MVP залишено платежі/рейтинги/чат. Production не заявляється як система без вразливостей або як перевірена на всіх платформах.

Додаткові технічні матеріали: [специфікація MVP](https://github.com/n25101882-svg/FixIT/blob/release/v1.0.0/FIXIT_MVP_SPEC.md), [чекліст релізу](https://github.com/n25101882-svg/FixIT/blob/release/v1.0.0/docs/RELEASE_CHECKLIST.md), [документація авторизації](https://github.com/n25101882-svg/FixIT/blob/release/v1.0.0/docs/FIX_17_REFRESH_SESSIONS.md).

## Команда розробників

| Учасник | Роль |
| --- | --- |
| **Тарас Вовк** | Scrum Master |
| **Ляшук Олександр** | Product Owner |
| **Сура Максим** | Frontend Developer |
| **Климчак Микола** | Backend Developer |
| **Філяс Олександр** | QA / Tester |

Проєкт виконано в межах дисципліни **«Проєктний практикум»**, IV курс, спеціальність 121 «Інженерія програмного забезпечення», Червоноградський гірничо-економічний фаховий коледж.
