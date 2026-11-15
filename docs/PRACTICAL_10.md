# Практична №10 — Unit Testing & Code Coverage

Фактична перевірка **15.11.2026**, Codex Cloud (дата Europe/Kyiv). Гілка `feature/practical-10-unit-coverage` створена від develop **f3655a36142661280c2083e1af6409943373ec95** після merge PR #4. Мета — виміряти критичний CUSTOM frontend-модуль, доповнити ізольовані Unit-тести й підтвердити FIX-18 регресією. Нових production-виправлень у цій роботі немає; FIX-17 не реалізовується.

## Налаштування вимірювання

Наявний **Vitest 5.1.0** збережено; у frontend workspace додано exact devDependency **@vitest/coverage-v8 5.1.0** і оновлено спільний lockfile. `npm ls vitest @vitest/coverage-v8 --workspace @fixit/frontend` підтвердив сумісні 5.1.0 та deduped Vitest. Чистий npm ci підтвердив відтворюваність.

`frontend/vite.config.ts`:

- provider **v8**;
- include — повні `src/orders.tsx` і `src/CancelOrderDialog.tsx`, без змін production source;
- reporters — text, html, json, json-summary;
- thresholds — **perFile=true**, Statements/Branches/Functions/Lines **71% для кожного файлу**. Команда завершується помилкою, якщо хоч одна метрика файла нижча за 71%; ціль «понад 70%» перевіряється окремо, а не середнім значенням;
- reportsDirectory — frontend/coverage. Наявне правило coverage/ у .gitignore вже ігнорує HTML/JSON/assets. Згенеровані звіти не входять до Git.

Виключень складних гілок, coverage ignore-анотацій, autoUpdate thresholds чи зміни source заради метрик не додано. Типові defaults Vitest не змінювалися. Вимірювання стосується **цих двох frontend-модулів**, не всього застосунку й не backend.

## Фактичне покриття

Джерело чисел — останній успішний `npm run frontend:coverage` і generated `frontend/coverage/coverage-summary.json`. Наведено саме значення Vitest; дроби дають змогу перевірити їх без ручного округлення.

| Модуль | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| orders.tsx | **96.49% (110/114)** | **88.69% (102/115)** | **100% (20/20)** | **100% (85/85)** |
| CancelOrderDialog.tsx | **96.77% (30/31)** | **95.65% (22/23)** | **100% (6/6)** | **100% (23/23)** |
| Разом за двома модулями | 96.55% (140/145) | 89.85% (124/138) | 100% (26/26) | 100% (108/108) |

Усі чотири показники **кожного** модуля понад 70%, per-file gate пройдено. Початкові 48 frontend-тестів уже давали >70%: orders branches 84.34%, dialog branches 91.30%. Додаткові тести перевіряють корисні непокриті сценарії: orders functions зросли з 95% до 100%, branches з 84.34% до 88.69%; dialog branches — з 91.30% до 95.65%.

100% Lines не означає 100% Statements/Branches: один фізичний рядок може містити кілька виразів. Залишились неперевірені defensive/unmount/fallback шляхи, зокрема guard діалогу без жодної кнопки та частина пізніх відповідей/відсутніх form values. Вони **залишені у знаменнику**, не приховані й не імітовані неприродним видаленням DOM-кнопок для досягнення 100%.

## Unit-тести та AAA

Усі попередні **48 frontend-тестів** (`App.test.tsx`, `orders.test.tsx`, `orders.review.test.tsx`) збережені без змін. Додано **12** у `frontend/src/orders.coverage.test.tsx`; фінально **60/60**. Кожен новий тест має Arrange → Act → Assert, HTTP mock, cleanup та незалежні synthetic fixture IDs. Реальних HTTP-запитів/паролів/БД для Unit coverage не потрібно.

| Додані перевірки | Кількість |
| --- | --- |
| Створення другої заявки зберігає першу картку й додає нову OPEN зверху | 1 |
| Required title/description/city/category зупиняють невалідний POST у формі | 4 |
| Серверні field errors title/description/category/budget: feedback/aria-describedby і збереження draft | 4 |
| POST 503: форма/дані збережені, немає вигаданого success | 1 |
| Підтверджений DELETE 500: OPEN картка збережена, можливий свідомий retry | 1 |
| Native close event закритого діалогу викликає dismiss без confirm | 1 |

HTML validation у Unit-тестах не замінює серверну Zod-перевірку — вона залишається у попередніх 198 backend-тестах. Існуючі Orders/review suites продовжують перевіряти 401/403/409, підтвердження/відмову/Escape/focus, автоматичну синхронізацію після конфлікту, збереження полів і статуси. Browser E2E окремо перевіряє native Chromium, а не тільки jsdom dialog shim.

## Bug reports: FIX-17 та FIX-18

### FIX-17 — втрата сесії після F5

- Відтворення: увійти CLIENT → /dashboard або /orders → F5.
- Фактична чинна поведінка: token лише в пам’яті AuthProvider, після повного reload його немає, protected route веде на /login.
- Стан у цій роботі: **відоме UX-обмеження, НЕ виправлено**. Потрібне окреме погоджене архітектурне рішення. JWT/storage/refresh/revocation механізми не змінювалися; passing coverage не означає усунення цього обмеження.

### FIX-18 — помилка GET приховувала форму

- До виправлення: авторизований CLIENT відкриває /orders → GET /api/v1/orders отримує network error або 5xx → разом із history приховується create form, створити заявку через UI неможливо до успішного GET.
- Після виправлення **689381374b505ec7c7717064abff825720c9649e**, merged у develop через PR #4: форма не залежить від loading/history error; можна створювати CUSTOM при тимчасовому збої історії, retry зберігає введені поля. 401 → logout, 403 → блокування CLIENT-функцій.
- Регресійні докази, збережені тут: cases `FIX-18` у orders.review.test.tsx (500/503/network, pending/retry/delayed GET, 401/403) та два browser cases в orders.review.spec.ts (history 503/network, реальний POST 201 і перевірка PostgreSQL).
- Стан у цій роботі: **існуюче виправлення підтверджене**, не видане за нове production-виправлення. Jira issues/statuses через API не змінювались; опис спирається на наданий контекст і перевірений код/регресію.

## Фактично виконані перевірки

Node 24.22.1, npm 11.9.0, TypeScript 5.9.3, Vitest/coverage-v8 5.1.0, PostgreSQL 18.6, Chromium 156.0.8078.79.

| Команда | Фактичний результат |
| --- | --- |
| npm ci --no-audit --no-fund | PASS, 644 packages, узгоджений lockfile |
| npm run typecheck | PASS |
| npm test | **198/198**, 7 suites, попередній backend-набір без змін |
| npm run frontend:test | **60/60**, 4 files: попередні 48 + 12 нових |
| npm run frontend:build | PASS, TypeScript + Vite production build |
| npm run frontend:coverage | **60/60**, V8 report і per-file thresholds PASS; точні відсотки вище |
| npm run test:e2e | **15/15**, попередні browser-сценарії без змін |
| Git byte comparison | Production frontend/backend, Prisma schema/міграції, JWT/business rules, старі tests і звіти №6/7/9 незмінні від f3655a3 |

Backend/E2E виконані лише на дозволеній локальній **fixit_orders_review_test**; Unit/coverage не під’єднуються до БД. Немає змін fixit_dev/production, reset/db push, schema edits або TLS/checksum bypass. test:migrations у №10 не запускався: міграції не змінювалися. Security audit/CI/Windows виконання не заявляються. Успадковані glob deprecation, Node VM modules, Playwright color-env warnings не є skipped tests. Ізоляція Vitest залишена ввімкненою, підказка runner-а про isolate:false не застосовувалась.

## Windows 11: локальна перевірка та докази

Node 24/npm 11, корінь репозиторію на гілці цієї роботи. У PowerShell (команди окремими рядками, сумісні також із Windows PowerShell 5.1):

```powershell
npm ci
npm run frontend:coverage
Start-Process .\frontend\coverage\index.html
```

Для цього Unit-вимірювання PostgreSQL/JWT_SECRET/.env не потрібні: HTTP mock-ований. У терміналі мають бути 60 passed і чотири Coverage метрики; у HTML відкрийте кожен із двох файлів. Подробиці чистого локального PostgreSQL test setup для optional backend/E2E — у README; не використовуйте fixit_dev/production.

Додаткові команди:

```powershell
npm run typecheck
npm test
npm run frontend:test
npm run frontend:build
# Для E2E лише після налаштування дозволеної TEST_DATABASE_URL:
npm exec playwright install chromium
npm run test:e2e
```

Справжні докази для звіту: власний screenshot terminal після frontend:coverage, HTML summary із двома файлами та чотирма метриками, сторінка модуля з підсвіченими uncovered branches. FIX-18 — опис кроків до/після й regression output; FIX-17 — відоме обмеження, не позначати виправленим. Не вигадуйте screenshots/статуси Jira, не підміняйте числа; паролі/URL/token приховуйте. Windows QA та ручні screenshots тут **не виконувались**.

Generated evidence: frontend/coverage/index.html, coverage-summary.json, coverage-final.json. HTML/JSON/assets **не комітяться**; reviewer відтворює їх командою. У поточному Cloud також підготовлений окремий ZIP generated reports і фактичного terminal coverage log поза Git; це артефакт перевірки, не screenshot.

## Відомі обмеження

- Покриття охоплює тільки два зазначені frontend-модулі. Це не відсоток всього проєкту/бекенду й не доказ відсутності багів.
- Unit-тести використовують jsdom/HTTP mocks; browser focus і реальний PostgreSQL перевірені окремими 15 E2E. Coverage не включає E2E hits.
- Частина defensive/unmount/fallback гілок не перевірена; source/exclusions для маскування цього не змінені.
- FIX-17 залишається невиправленим; архітектура/бізнес-правила та всі обмеження MVP з попередніх практичних збережені.
- Windows/manual screenshots/CI не запускалися, HTML треба згенерувати локально. PR до develop лишається без автоматичного merge.
