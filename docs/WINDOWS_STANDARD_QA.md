# Windows 11 QA checklist — STANDARD Orders

Це інструкція ручної перевірки, не звіт про виконання Windows. Фактичні Cloud результати — [US_04_STANDARD.md](US_04_STANDARD.md).

## Підготовка

- [ ] Node 24/npm 11, PostgreSQL 18 і psql у PATH.
- [ ] Через власного локального адміністратора створена **окрема** loopback `fixit_standard_test` для обмеженої test-role (створювати тільки відсутню, не видаляти/не reset наявну).
- [ ] Приватний `.env` налаштований за `.env.example`: DATABASE_URL/TEST_DATABASE_URL — ця *_test DB, SHADOW_DATABASE_URL — інша DB; JWT_SECRET власний випадковий, не source code. Не використовувати fixit_dev/production.
- [ ] Перед migrate звірено поточну назву БД. Паролі/connection strings/JWT не публікуються й не потрапляють у screenshots.

```powershell
git fetch origin
git switch feature/us-04-standard-orders
if (!(Test-Path .env)) { Copy-Item .env.example .env }
# Спершу налаштуйте приватні test bindings.
npm ci
npm run db:generate
npm run db:migrate
npm run db:status
npm run db:validate
npm run er:validate
npm run typecheck
npm test
npm run frontend:test
npm run frontend:build
npm run frontend:coverage
npm exec playwright install chromium
npm run test:e2e
```

- [ ] На Windows не задано Linux PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. E2E сам запускає test servers 4100/5174 зі випадковим secret, не використовує production.
- [ ] Для ручної QA у першому терміналі `npm run dev` (API 127.0.0.1:3000), у другому `npm run frontend:dev` (UI 127.0.0.1:5173). Один hostname для CORS.
- [ ] Два окремі браузерні профілі: CLIENT і MASTER. Використовуються тільки synthetic name/email/password. MASTER має профіль і активну послугу.

## Оформлення від гостя

- [ ] У гостьовому вікні відкрито /catalog, знайдено активну Service. Можна також відкрити /masters/:id.
- [ ] «Замовити послугу» веде на login із returnTo лише на `/orders/new/standard/<Service.id>`.
- [ ] Після CLIENT login відкривається саме ця форма, а не довільний external URL. За потреби register → login зберігає контекст.
- [ ] Показані title, master name, місто надання послуги, Service.category й estimate. Місто readonly, це **MasterProfile.city**, не адреса клієнта.
- [ ] Без city checkbox submit заблокований. Без/із whitespace description немає POST або є валідний field error; район можна вказати в описі, точну адресу не збираємо.
- [ ] Заповнений опис і city checkbox → Network POST `/api/v1/orders/standard` **201**. Body тільки serviceId/description/expectedSnapshot; немає clientId/masterProfileId/price/status/role/city.
- [ ] Під час POST повторні натискання заблоковані. Після 201 є success/PENDING і перехід до історії, не повторний POST.
- [ ] Збережено synthetic Order.id та Service.id з response (не JWT).

## Виконання та історія

- [ ] CLIENT → /orders: STANDARD із назвою послуги, виконавцем, snapshot міста/категорії/ціни, датою й PENDING («Очікує відповіді»). CUSTOM лишається у спільній історії.
- [ ] MASTER /dashboard → свої PENDING STANDARD, без замовлень іншого майстра. Є «Прийняти» й «Відхилити».
- [ ] «Прийняти» → PATCH ACCEPTED **200**, потім «Розпочати роботу» → IN_PROGRESS **200**, «Завершити роботу» → COMPLETED **200**; зміни без F5.
- [ ] CLIENT після «Оновити» бачить «Прийнята» → «У роботі» → «Завершена» та відому дату завершення.
- [ ] Після IN_PROGRESS кнопки скасування немає; прямий CLIENT DELETE → **409**, історія/запис незмінні.
- [ ] Інша нова заявка → MASTER «Відхилити» → DECLINED. Дій виконання/скасування більше немає, запис є в обох історіях.
- [ ] Інша нова PENDING або ACCEPTED → CLIENT діалог скасування → CANCELLED **200**. Запис лишається, повторний DELETE → **409**.
- [ ] Після редагування Service title/category/price чи profile city старий Order і його history не переписуються. Null estimate показано «Ціна за домовленістю», не 0.

## Помилки та конкурентні сесії

- [ ] MASTER не може відкрити CLIENT booking API/форму (403); guest API без JWT → 401.
- [ ] Чужий MASTER PATCH → 403; чужий CLIENT DELETE → 403; додаткові protected fields/invalid UUID/empty body → 400 без нового Order.
- [ ] Послуга прихована ДО preview: 404 й немає форми; старий URL не обходить це після login.
- [ ] Послуга прихована ПІСЛЯ preview: POST → 409, GET preview → 404, немає фальшивого success чи Order.
- [ ] Ціна/назва/категорія/місто змінені після preview: POST з old fingerprint → 409, форма перечитує дані, description лишається, city checkbox скинутий. Новий свідомий confirm створює current snapshot.
- [ ] Дві MASTER сесії одночасно приймають/відхиляють PENDING: один 200, інший 409. UI другої сесії перечитує реальний стан, нової зайвої DB-події немає.
- [ ] Для мережевої/5xx помилки (наприклад через локальний test harness/DevTools) немає auto POST або false success. «Перевірити мою історію» робить GET, description лишається. Manual retry потребує успішної перевірки історії й explicit retry/city checkboxes. Якщо попереднє замовлення є — не повторюйте його.
- [ ] Не робіть F5 під час POST: in-memory draft/uncertainty state й JWT не зберігаються (FIX-17). Після перезавантаження/повторного login перевірте історію перед новим оформленням.

## PostgreSQL status_history

Виконайте у psql для дозволеної *_test DB, замінивши placeholder **власним synthetic Order UUID**. Це SELECT, не UPDATE/reset.

```sql
SELECT id, type, status, client_id, service_id, master_profile_id,
       title, category, city, price_at_order, created_at, updated_at
FROM orders WHERE id = '<synthetic-order-uuid>';

SELECT e.ordinality AS event_no, e.value->>'status' AS status,
       e.value->>'at' AS changed_at, e.value->>'source' AS source,
       e.value->>'actorUserId' AS actor_user_id, u.role AS actor_role
FROM orders o
CROSS JOIN LATERAL jsonb_array_elements(o.status_history)
  WITH ORDINALITY AS e(value, ordinality)
LEFT JOIN users u ON u.id = (e.value->>'actorUserId')::uuid
WHERE o.id = '<synthetic-order-uuid>'
ORDER BY e.ordinality;
```

- [ ] Успішне виконання: **PENDING → ACCEPTED → IN_PROGRESS → COMPLETED**, одна подія кожного стану.
- [ ] Початкова подія від User.id CLIENT, наступні від User.id призначеного MASTER; це не MasterProfile.id. source=database, дати справжні.
- [ ] Відхилення: PENDING → DECLINED. Скасування: PENDING → CANCELLED або PENDING → ACCEPTED → CANCELLED.
- [ ] Record service_id/master_profile_id/title/category/city/price_at_order відповідає підтвердженому snapshot, а не поточним відредагованим полям Service.
- [ ] За потреби зняті справжні CLIENT/MASTER/Network/SQL докази лише із synthetic даними, без видимого Authorization/JWT/.env/паролів. Ця інструкція не стверджує, що Windows QA чи screenshots уже виконані.
