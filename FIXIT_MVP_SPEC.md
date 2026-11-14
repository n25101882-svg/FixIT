# FixIT — Hybrid MVP 1.0

Практична №6 розвиває наявну PostgreSQL 18 / Prisma 7.10.1 базу з п’ятьма сутностями. Це основа MVP, а не реалізація всього backlog. Initial `20261109200000_init_database_schema` і вже застосована Hybrid `20261114130000_hybrid_mvp` незмінні. Review-виправлення — наступна `20261114150000_review_snapshot_alignment`, без reset/db push.

## Межі й ролі

Публічні ролі — CLIENT і MASTER. ADMIN та isApproved збережені тільки для сумісності старих даних, без адміністративного UI, public ADMIN registration чи нового approval workflow. ADMIN не обходить правила серверних команд.

- CLIENT створює STANDARD/CUSTOM, обирає одного виконавця для власного OPEN CUSTOM і скасовує свою заявку до початку роботи.
- MASTER має власний профіль/послуги, подає одну пропозицію на OPEN CUSTOM; призначений майстер приймає/відхиляє STANDARD, починає та завершує роботу.
- Auth/JWT/React залишаються у відкритому [PR #2](https://github.com/n25101882-svg/FixIT/pull/2). Поточний backend має /health і /health/ready. Нові HTTP-маршрути запису не відкриті.

`src/orders/service.ts` — внутрішні транзакційні команди. actorId у майбутньому надходитиме лише з перевіреного JWT/current User, не з body; роль/належність повторно читаються з БД. Каталог, стрічка з фільтрами за містом/категорією, екрани та авторизовані API належать наступним задачам, тут не оголошуються готовими. Reviews, платежі, OAuth, Agreements і чат не додаються.

## Фізична модель

Канонічна фізична ER — [docs/er-diagram.dbml](docs/er-diagram.dbml); Prisma @map/@@map відтворюють SQL snake_case. PK — UUID/gen_random_uuid(); часові поля — timestamptz(3). Пароль зберігається лише як passwordHash.

| Prisma / SQL | Дані й зв’язки |
| --- | --- |
| User / users | id, email UNIQUE/canonical lowercase, passwordHash, name, role, createdAt. CLIENT → N Orders; MASTER → 0..1 MasterProfile на рівні зберігання legacy. |
| MasterProfile / master_profiles | id, userId UNIQUE FK, city, category, nullable description (колишній bio), внутрішній isApproved. Лише User із MASTER може мати профіль. |
| Service / services | id, masterProfileId FK, title, category, nullable description і priceEstimate, isActive. UNIQUE(id,masterProfileId) для складеного FK. |
| Order / orders | id, clientId FK, type, nullable serviceId/masterProfileId, title, city, category, description, nullable priceAtOrder/budget, status, createdAt, updatedAt, statusHistory JSONB. CHECK уточнює форму залежно від type/status. |
| OrderResponse / order_responses | id, orderId FK, masterProfileId FK, message, nullable proposedPrice, createdAt. UNIQUE(orderId,masterProfileId). Це пропозиція, не рейтинг/Review. |

Enums: user_role = ADMIN/CLIENT/MASTER (ADMIN legacy); order_type = STANDARD/CUSTOM; order_status = OPEN/PENDING/ACCEPTED/IN_PROGRESS/COMPLETED/CANCELLED/DECLINED; service_category = TECH_REPAIR/PLUMBING/ELECTRICAL/OTHER. Prisma enum зберігає назву Category.

## Звірка з наданими матеріалами

Джерела — оновлені практичні №1 (FIX-1, AC4–5), №4 (§3.1, FR-01, FR-07), №5 (§4.1–4.3, примітка про уточнення фізичних типів у №6) та ER-зображення з чату. Це матеріали вимог; їхні описи backlog/роботи команди не є твердженням про виконаний тут код. Нижче — явні уточнення, а не твердження про побайтовий збіг із початковою картинкою. DOCX-файли не редагуються/не додаються до Git. Ту саму звірку з деталями має [звіт №6](docs/PRACTICAL_6.md).

| Відмінність / рішення | Навіщо, публічність та інваріант | Що актуалізувати у вихідних ER/звітах |
| --- | --- | --- |
| ADMIN, isApproved залишені | Внутрішня legacy-сумісність без втрати даних. Не public роль/approval gate; роль сервісу перевіряється з БД. | Позначити як internal legacy в ER; не додавати до public MVP. |
| Service.category залишена | Є у логічних моделях №4–5, хоча пропущена на ER-зображенні. Публічний атрибут фільтрації послуг; валідний enum. | Додати колонку в ER, не видаляти вже відомі категорії. |
| category → service_category | Узгоджена назва PostgreSQL enum з картинки. Значення/посилання збережені через RENAME TYPE. | Нова DBML уже використовує service_category. |
| price → price_estimate / priceEstimate, nullable | На картинці ціна необов’язкова; FIX-1 не вимагає ціни першої послуги. Прибрано необґрунтовану вимогу, збережено всі старі суми. | DBML узгоджено; у тексті звіту вживати «орієнтовна ціна». |
| Service.description nullable | Відповідає ER. На майбутній формі першої послуги короткий опис обов’язковий за FIX-1; SQL не фальсифікує старі дані. | Розрізняти nullable зберігання і валідацію нової реєстрації. |
| Order.budget nullable додано | Публічний необов’язковий бюджет CUSTOM (№1/FIX-5, ER). Не ціна обраної пропозиції. STANDARD має NULL; після створення незмінний. | DBML тепер містить budget. |
| proposedPrice nullable | ER вимагає текст пропозиції, але не суму. Текстова пропозиція дозволена; якщо є сума — decimal(10,2), >=0. Не аукціон/платіж. | Відобразити optional estimate у фізичній ER і №6. |
| priceAtOrder залишено nullable | Додатковий історичний snapshot ціни послуги/обраної пропозиції, зі збереженням старих cents. Не обов’язкова оплата/узгоджена остаточна вартість. NULL лишається невідомою ціною. | Додати до фізичної ER; не називати budget. |
| statusHistory JSONB залишено | Публічна історія станів без шостої таблиці; append-only через БД. Legacy — одне спостереження, не вигадана історія. | Відобразити технічну реалізацію історії в ER/№6. |
| masterId → masterProfileId | FK завжди веде в MasterProfile; JWT subject — інший ID, User.id. Публічний бізнес-зміст не змінено. | Уніфікувати фізичне ім’я в №4–5; actor → profile lookup. |
| comment → message | Назва з ER-зображення; зміст — непорожній текст пропозиції. | Уточнити mapping логічного comment у №5. |
| display_name не дублюється | Окремий бренд/псевдонім не заданий у FIX-1; display name читається з User.name. Не додаємо друге редаговане джерело імені. | Позначити похідне поле на логічній ER, прибрати фізичний дубль. |
| MasterProfile.description nullable | Старий bio міг бути NULL. Текст/NULL збережено; нова MASTER-реєстрація в інтеграції вимагатиме опис. | Позначити legacy-nullability в фізичній ER. |
| User.updated_at, Profile/Service created_at/updated_at не додаються | Окремий аудит цих сутностей не вимагається логічною моделлю/FIX-1; старі дати невідомі. Не прирівнюємо їх до дати міграції. Order.updatedAt є для життєвого циклу. | Прибрати необґрунтовані фізичні поля з ER; окрему вимогу аудиту оформлювати надалі. |
| completed_at як похідне, не колонка | Час з реальної database-події COMPLETED у statusHistory; для legacy COMPLETED точний час невідомий → NULL у майбутньому DTO. | Позначити derived/unknown legacy; не дублювати timestamp або вигадувати його. |
| name(100), email(254), title(160) збережені | Наявні контракти й межі не звужуються; 160-символьний legacy title не обрізається до 150. Публічна валідація має використовувати ці ж межі. | Узгодити початкові 150/255/150 на картинці з фактичними 100/254/160. |
| Scrypt-хеші збережені, хоча №4 згадує bcrypt | Безпечний salted scrypt/self-described hash — чинний контракт №6/PR #2. Пароль лише як хеш; конвертація без пароля неможлива. | Уточнити алгоритм у технічному звіті, не переписувати hashes. |

## Гроші та міграції

Валюта UAH, усі чотири грошові колонки decimal(10,2), nullable, 0.00–99999999.99. CHECK відкидає negative/NaN; typmod відкидає overflow. Команди приймають точні десяткові рядки максимум із двома дробовими цифрами, без float/exponent/неявного округлення. PostgreSQL сам округлює зайву дробову точність при coercion — це не заміна серверної валідації.

Hybrid ділить integer cents точно на numeric 100: 1 → 0.01, 25000 → 250.00, 2147483647 → 21474836.47. Зберігає ID, зв’язки, description, createdAt, всі старі Orders/statuses; робить їх STANDARD. Master/title/city/category — одноразовий backfill з поточних зв’язків. Невідомі legacy-категорії й порожні required metadata викликають атомарну відмову, а не мовчазну заміну/втрату. Nullable bio → description без втрати NULL. Категорія профілю — єдина відома категорія послуг, інакше OTHER.

Legacy history — одне спостереження source=legacy_migration з часом міграції та відомим legacyCreatedAt, не реконструкція давніх подій. Review-міграція не переписує цей backfill, history чи timestamps: лише RENAME, nullable money/description, nullable budget і посилений guard. Повторний deploy — без змін.

## STANDARD і CUSTOM

STANDARD: serviceId/masterProfileId обов’язкові, budget=NULL, початковий PENDING. Складений FK гарантує належність послуги майстру. Сервер перевіряє CLIENT, активність послуги, бере shared lock і копіює title/city/category/priceEstimate. Невідома ціна дає NULL snapshot, не нуль. Подальша зміна послуги не змінює замовлення.

CUSTOM: початковий OPEN, serviceId/masterProfileId/priceAtOrder=NULL; непорожні title/city/description, валідна category, необов’язковий budget. Один MASTER-профіль — одна immutable OrderResponse на OPEN CUSTOM; message обов’язкове, proposedPrice необов’язкове. Наразі перевіряються роль/власність/стан; фільтрація стрічки за містом/категорією з FR-07 ще не реалізована й має окремо перевірятися при підключенні API.

CLIENT-власник обирає відповідь саме своєї заявки. FOR UPDATE і повторна перевірка OPEN/відсутності виконавця в одній транзакції встановлюють masterProfileId, priceAtOrder=proposedPrice (включно з NULL), ACCEPTED. Один конкурентний вибір commit, інший CONFLICT. SQL додатково перевіряє наявність пропозиції через NULL-safe порівняння ціни. Виконавця/ціну після вибору не перепризначити, вибрану пропозицію не видалити.

## Незмінність і статуси

Після INSERT title, city, category, description та budget незмінні для обох типів: окремого сценарію редагування заявки немає. Перевірка ROW IS DISTINCT FROM охоплює NULL; ті самі значення дозволені. Identity/type/client/service/createdAt і price snapshot також захищені. Відхилений UPDATE не змінює жодного історичного поля, updatedAt чи history; помилка відкочує попередні записи транзакції.

| Поточний стан | Наступний | Хто |
| --- | --- | --- |
| CUSTOM OPEN | ACCEPTED | CLIENT-власник через selectResponse |
| CUSTOM OPEN | CANCELLED | CLIENT-власник |
| STANDARD PENDING | ACCEPTED / DECLINED | Призначений MASTER |
| STANDARD PENDING | CANCELLED | CLIENT-власник |
| ACCEPTED | IN_PROGRESS | Призначений MASTER |
| ACCEPTED | CANCELLED | CLIENT-власник до початку робіт |
| IN_PROGRESS | COMPLETED | Призначений MASTER |

COMPLETED/CANCELLED/DECLINED кінцеві; пропуски й повторні переходи відхиляються. Скасування після початку робіт заборонено. SQL задає допустимий граф, сервер — роль/власність. statusHistory/updatedAt підтримує БД; actorUserId у transaction-local context є аудитом, не автентифікацією.

## FIX-1 та інтеграція з PR #2

У поточному PR #2 MASTER створюється тільки як User: це **ще не повний FIX-1**. Після прийняття #3 та оновлення основи #2 від develop потрібна одна бізнес-транзакція **User + MasterProfile + перша Service**, із city/category/title/коротким описом із форми (не вигаданими defaults), optional priceEstimate; CLIENT не створює профілю. JWT/успішна відповідь лише після commit. Сервер забороняє ADMIN і перевіряє унікальність email/поля.

Обов’язкові інтеграційні тести наступного доопрацювання #2: успіх MASTER створює рівно три пов’язані записи; помилка третього запису відкочує всі три; email race/невалідний профіль не лишають orphan; CLIENT створює лише User; ADMIN відхилений. Тут перевіряється лише здатність БД до такої транзакції/rollback, не готовність register endpoint.

README/spec/package конфлікти вирішуються після оновлення #2, зі збереженням трьох migrations, Hybrid і Auth suites, test:migrations, frontend scripts, JWT/CORS та тестових environment bindings. Повний план і фактичні перевірки — у звіті №6. Auth/React тут не додаються й не оголошуються перевіреними.
