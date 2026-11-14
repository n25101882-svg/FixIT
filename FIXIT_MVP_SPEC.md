# FixIT — Hybrid MVP 1.0

Практична №6: міграційна еволюція наявної PostgreSQL 18 / Prisma 7.10.1 бази, п’ять сутностей і серверні правила STANDARD/CUSTOM. Це не новий Prisma-проєкт. Initial migration `20261109200000_init_database_schema` збережена без змін; доповнення — `20261114130000_hybrid_mvp`.

## Межі й ролі

Публічні ролі продукту — CLIENT і MASTER. ADMIN залишений у старому PostgreSQL enum/User як внутрішня сумісність, не є публічною роллю реєстрації; адміністративного UI немає. User/passwordHash/email/UUID контракт не змінюється для майбутнього інтегрування PR #2.

- CLIENT створює STANDARD/CUSTOM заявки, бачить свою історію, обирає одну пропозицію для власного OPEN CUSTOM та скасовує свою заявку до початку роботи.
- MASTER із власним профілем подає одну пропозицію на OPEN CUSTOM. Лише призначений майстер приймає/відхиляє STANDARD, починає й завершує роботу.
- ADMIN не обходить бізнес-правила сервісу. Жодної публічної можливості призначити себе ADMIN ця гілка не додає.

Auth/JWT/React залишаються у відкритому PR #2. Ця гілка не копіює його залежності, middleware або frontend. Існуючий Express backend має /health та /health/ready; нові мутації доступні тільки через внутрішній серверний `createOrderService`, а не незахищені HTTP endpoints. Переданий actorId має надходити з довіреної автентифікації, ніколи не з request body. Роль та належність перевіряються повторно за БД.

## Фізична модель

Усі PK — UUID із PostgreSQL gen_random_uuid(), часові поля — TIMESTAMPTZ(3). Фізичні назви snake_case зафіксовані в DBML і Prisma @@map/@map.

| Prisma / SQL | Дані та зв’язки |
| --- | --- |
| User / users | Незмінні id, email UNIQUE/canonical lowercase, passwordHash, name, role, createdAt. Пароль тільки як хеш. CLIENT має N Orders; MASTER має 0..1 профіль. |
| MasterProfile / master_profiles | id, userId UNIQUE FK, city, category, nullable description. Категорія обов’язкова, типовий OTHER. Старий nullable bio перейменований без втрати NULL/тексту. isApproved збережений як внутрішнє старе поле; нового approval workflow/UI немає. |
| Service / services | id, masterProfileId FK, title, category, description, price decimal(10,2), isActive. Один майстер має N готових послуг. Технічний UNIQUE(id, masterProfileId) потрібний для складеного FK замовлення. |
| Order / orders | id, clientId FK, type, nullable serviceId/masterProfileId/priceAtOrder, title, city, category, description, status, createdAt, updatedAt, statusHistory JSONB. Nullable колонки дозволені глобально через CUSTOM, але CHECK вимагає правильну форму для конкретного type/status. |
| OrderResponse / order_responses | id, orderId FK, masterProfileId FK, proposedPrice decimal(10,2), message, createdAt; UNIQUE(orderId, masterProfileId). Це пропозиція майстра, а не Review/рейтинг. |

Enums: order_type = STANDARD/CUSTOM; order_status = OPEN/PENDING/ACCEPTED/IN_PROGRESS/COMPLETED/CANCELLED/DECLINED; category = TECH_REPAIR/PLUMBING/ELECTRICAL/OTHER. Значення category однакові для профілів, послуг і заявок. Місто/категорія — атрибути пошуку, а не прихована додаткова заборона майстру з іншого міста подати пропозицію.

## Гроші й перенесення даних

Єдина валюта — UAH. price, priceAtOrder та proposedPrice — DECIMAL(10,2), діапазон 0.00–99999999.99; CHECK відкидає також NaN. Для команд із зовнішньою ціною використовується десятковий **рядок** до двох дробових цифр, без exponent/float та неявного округлення. Prisma.Decimal не переводиться у JavaScript Number для арифметики.

Міграція перейменовує price_cents → price і price_at_order_cents → price_at_order та виконує точне PostgreSQL numeric / 100. Наприклад, 1 → 0.01, 25000 → 250.00, 2147483647 → 21474836.47. Старий integer діапазон повністю вміщується у DECIMAL(10,2). ID, client/service links, опис, статус і createdAt старих Orders зберігаються. Усі вони стають STANDARD; masterProfileId/title/city/category заповнюються з наявного зв’язку Service → MasterProfile на час міграції. Історичні значення цих раніше відсутніх полів не вигадуються.

Один спостережений legacy-статус записується у statusHistory з source=legacy_migration і часом **міграції**, разом із legacyCreatedAt. Це не реконструкція відсутньої повної історії. updatedAt для старого запису також встановлюється на час міграції. Оригінальний createdAt незмінний.

Старі невідомі строкові категорії не замінюються мовчки на OTHER: міграція атомарно відмовляється, доки власник явно не класифікує їх. Так само відхиляються порожні обов’язкові старі title/city/order description. Нова категорія профілю виводиться з єдиної категорії його послуг; за відсутності/неоднозначності — OTHER, бо старого значення профілю не було.

## Правила STANDARD

serviceId/masterProfileId/priceAtOrder обов’язкові; початковий статус PENDING. Складений FK (serviceId, masterProfileId) → Service(id, masterProfileId) гарантує, що послуга належить цьому майстру. Сервер перевіряє CLIENT, активність послуги та відповідність майстра, бере shared row lock і копіює поточну ціну/метадані в заявку. Наступна зміна ціни послуги не переписує snapshot заявки.

## Правила CUSTOM

Початковий OPEN, serviceId=NULL, masterProfileId=NULL, priceAtOrder=NULL. Обов’язкові непорожні city/title/description та валідна category. Профілі MASTER можуть додавати OrderResponse лише до OPEN CUSTOM; ціна й message обов’язкові, одна пропозиція від одного профілю. Зміна пропозиції не є функцією цього MVP.

Лише CLIENT-власник заявки може обрати пропозицію саме цієї заявки. В одній транзакції сервер бере FOR UPDATE на Order, повторно перевіряє OPEN/відсутність призначення, знаходить OrderResponse і встановлює masterProfileId, priceAtOrder=proposedPrice, status=ACCEPTED. Конкурентний вибір серіалізується: одна транзакція перемагає, інша отримує CONFLICT; другого виконавця чи зайвої події історії немає. SQL trigger також перевіряє наявність відповідної пропозиції/ціни. Вибраного майстра й snapshot потім не можна перепризначити.

## Статуси та належність

| Поточний стан | Наступний | Хто |
| --- | --- | --- |
| CUSTOM OPEN | ACCEPTED | CLIENT-власник через selectResponse |
| CUSTOM OPEN | CANCELLED | CLIENT-власник |
| STANDARD PENDING | ACCEPTED / DECLINED | Призначений MASTER |
| STANDARD PENDING | CANCELLED | CLIENT-власник |
| ACCEPTED | IN_PROGRESS | Призначений MASTER |
| ACCEPTED | CANCELLED | CLIENT-власник або призначений MASTER |
| IN_PROGRESS | COMPLETED / CANCELLED | Призначений MASTER |

COMPLETED/CANCELLED/DECLINED — кінцеві. Переходи в той самий стан та пропуски кроків відхиляються. CUSTOM не використовує PENDING/DECLINED. Сервер читає власність/роль із БД під транзакцією; SQL trigger незалежно забороняє недопустимі переходи, зміну початкового type/client/service та snapshot. statusHistory автоматично доповнюється подіями status/at/actorUserId/source, прямий rewrite відхиляється. actorUserId із transaction-local context — аудит серверної команди, не заміна JWT-автентифікації.

## SQL-обмеження та історія

7 FK, включно зі складеним Service/master FK; PK/UNIQUE/NOT NULL/enum; CHECK форми STANDARD/CUSTOM, цін, тексту, JSON-історії та canonical email. Збережені role triggers №6; додані orders_guard_hybrid й order_responses_guard. Операції з пропозиціями блокують батьківську заявку, тому запис/видалення не переганяє вибір виконавця. Вибрану пропозицію видалити не можна. FK використовують RESTRICT для видалення пов’язаних записів; історія не каскадно знищується. Видалення чи очищення історії не є публічною операцією MVP.

Не додаються шоста таблиця історії, дубльований accepted-response flag, ADMIN UI, Auth із PR #2, Reviews, платежі, OAuth або чат. Подальші endpoint-и мають бути захищені middleware PR #2 та викликати саме серверні команди.
