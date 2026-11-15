import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type ServiceCategory } from "./api";
import { useAuth } from "./auth";
import { CancelOrderDialog } from "./CancelOrderDialog";
import { ClientOffers, type PublicMaster } from "./ClientOffers";

export interface Order {
  id: string;
  type: "CUSTOM" | "STANDARD";
  title: string;
  description: string;
  city: string;
  category: ServiceCategory;
  budget: string | null;
  status: "OPEN" | "PENDING" | "ACCEPTED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | "DECLINED";
  createdAt: string;
  masterProfileId?: string | null;
  assignedMaster?: PublicMaster | null;
  updatedAt?: string;
  statusHistory?: { status: string }[];
  completedAt?: string | null;
  serviceId?: string | null;
  priceAtOrder?: string | null;
}
function newest(incoming: Order, current?: Order): Order {
  if (current && ((current.statusHistory?.length ?? 0) > (incoming.statusHistory?.length ?? 0)
    || (current.updatedAt && incoming.updatedAt && current.updatedAt > incoming.updatedAt))) return current;
  return incoming;
}
export const categories: Record<ServiceCategory, string> = {
  TECH_REPAIR: "Ремонт техніки", PLUMBING: "Сантехніка", ELECTRICAL: "Електрика", OTHER: "Інше",
};
export const statuses: Record<Order["status"], string> = {
  OPEN: "Відкрита", PENDING: "Очікує відповіді", ACCEPTED: "Прийнята", IN_PROGRESS: "У роботі",
  COMPLETED: "Завершена", CANCELLED: "Скасована", DECLINED: "Відхилена",
};
const canCancel = (status: Order["status"]) => ["OPEN", "PENDING", "ACCEPTED"].includes(status);

export function OrdersPage() {
  const { token, logout } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [historyStale, setHistoryStale] = useState(false);
  const [pendingCancel, setPendingCancel] = useState<Order | null>(null);
  const historyRequest = useRef(0);
  const historyController = useRef<AbortController | null>(null);
  const active = useRef(true);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const busy = saving || cancelling !== null || pendingCancel !== null;

  const loadOrders = useCallback(async () => {
    const request = ++historyRequest.current;
    historyController.current?.abort();
    const controller = new AbortController();
    historyController.current = controller;
    setLoading(true);
    setLoadError("");
    try {
      const data = await api<{ orders: Order[] }>("/orders", { token: token!, signal: controller.signal });
      if (request !== historyRequest.current || !active.current) return;
      setOrders((current) => data.orders.map((order) => newest(order, current.find((row) => row.id === order.id))));
      setLoaded(true); setHistoryStale(false); setForbidden(false);
    } catch (cause) {
      if (controller.signal.aborted || request !== historyRequest.current || !active.current) return;
      if (cause instanceof ApiError && cause.status === 401) logout(true);
      else {
        if (cause instanceof ApiError && cause.status === 403) setForbidden(true);
        setHistoryStale(true);
        setLoadError(cause instanceof Error ? cause.message : "Не вдалося завантажити заявки.");
      }
    } finally {
      if (request === historyRequest.current && active.current) setLoading(false);
    }
  }, [token, logout]);

  useEffect(() => {
    active.current = true;
    void loadOrders();
    return () => { active.current = false; historyRequest.current++; historyController.current?.abort(); };
  }, [loadOrders]);

  function invalidatePendingHistory() {
    // A GET started before the mutation must not overwrite its committed result.
    historyRequest.current++;
    historyController.current?.abort();
    setLoading(false);
  }
  function updateFromOffers(order: Order, selected = false) {
    if (selected) invalidatePendingHistory();
    setOrders((rows) => rows.map((row) => row.id === order.id ? newest(order, row) : row));
    if (selected) setNotice("Виконавця обрано.");
  }

  function mutationError(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 401) logout(true);
    else {
      if (cause instanceof ApiError && cause.status === 403) {
        invalidatePendingHistory();
        setForbidden(true);
      }
      setError(cause instanceof Error ? cause.message : "Не вдалося виконати запит.");
      setFields(cause instanceof ApiError ? cause.fields ?? {} : {});
    }
  }
  function refresh() {
    void loadOrders();
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const budget = String(values.get("budget") ?? "").trim();
    setSaving(true); setError(""); setFields({}); setNotice("");
    try {
      const { order } = await api<{ order: Order }>("/orders", {
        method: "POST", token: token!, body: {
          title: String(values.get("title") ?? ""), description: String(values.get("description") ?? ""),
          city: String(values.get("city") ?? ""), category: String(values.get("category") ?? ""),
          ...(budget ? { budget } : {}),
        },
      });
      if (!active.current) return;
      invalidatePendingHistory();
      setOrders((current) => [order, ...current.filter((item) => item.id !== order.id)]);
      form.reset();
      setNotice("Заявку створено.");
    } catch (cause) { mutationError(cause); }
    finally { setSaving(false); }
  }
  async function cancel(id: string) {
    setCancelling(id); setError(""); setFields({}); setNotice("");
    try {
      const { order } = await api<{ order: Order }>(`/orders/${id}`, { method: "DELETE", token: token! });
      if (!active.current) return;
      invalidatePendingHistory();
      setOrders((current) => current.map((item) => item.id === order.id ? order : item));
      setNotice("Заявку скасовано.");
    } catch (cause) {
      if (!active.current) return;
      mutationError(cause);
      if (cause instanceof ApiError && cause.status === 409) {
        setHistoryStale(true);
        // Keep the conflict message even when revalidation fails or is retried.
        await loadOrders();
      }
    }
    finally { setCancelling(null); }
  }
  const fieldError = (name: string) => fields[name]
    ? <span className="field-error" id={`order-${name}-error`}>{fields[name]}</span> : null;

  return (
    <section className="orders-page">
      <div className="orders-heading">
        <div><span className="eyebrow">ВАША ДОПОМОГА ПОРУЧ</span><h1>Мої заявки</h1></div>
        <Link className="nav-link" to="/dashboard">До кабінету</Link>
      </div>
      <p className="orders-intro">Опишіть проблему, з якою потрібна допомога, та стежте за станом своїх заявок.</p>
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
          <div className="orders-grid">
            {!forbidden && <form className="profile-card order-form" onSubmit={create} aria-label="Нова заявка">
              <h2>Нова заявка</h2>
              <fieldset disabled={busy} className="order-fields">
                <label htmlFor="order-title">Назва проблеми</label>
                <input id="order-title" name="title" required maxLength={160} aria-invalid={!!fields.title} aria-describedby={fields.title ? "order-title-error" : undefined} />
                {fieldError("title")}
                <label htmlFor="order-description">Опис проблеми</label>
                <textarea id="order-description" name="description" rows={4} required maxLength={4000} aria-invalid={!!fields.description} aria-describedby={fields.description ? "order-description-error" : undefined} />
                {fieldError("description")}
                <label htmlFor="order-city">Місто</label>
                <input id="order-city" name="city" required maxLength={100} autoComplete="address-level2" aria-invalid={!!fields.city} aria-describedby={fields.city ? "order-city-error" : undefined} />
                {fieldError("city")}
                <label htmlFor="order-category">Категорія</label>
                <select id="order-category" name="category" required defaultValue="" aria-invalid={!!fields.category} aria-describedby={fields.category ? "order-category-error" : undefined}>
                  <option value="" disabled>Оберіть категорію</option>
                  {Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                {fieldError("category")}
                <label htmlFor="order-budget">Бюджет, грн (необов’язково)</label>
                <input id="order-budget" name="budget" inputMode="decimal" maxLength={11} pattern={"[0-9]{1,8}(\\.[0-9]{1,2})?"} placeholder="Наприклад, 250.50" aria-invalid={!!fields.budget} aria-describedby={fields.budget ? "order-budget-error" : undefined} />
                {fieldError("budget")}
              </fieldset>
              <button className="primary-button" disabled={busy}>{saving ? "Створюємо…" : "Створити заявку"}</button>
            </form>}
            <div className="orders-list" aria-label="Мої замовлення">
              <div className="orders-list-heading"><h2 id="orders-history-title" tabIndex={-1}>Історія заявок</h2><button className="secondary-button" disabled={busy || loading || forbidden} onClick={refresh}>Оновити</button></div>
              {loading && <p role="status">Завантажуємо заявки…</p>}
              {loadError && <div className="notice error"><p role="alert">{loadError}</p>
                {orders.length > 0 && <p>Історія може бути неактуальною. Оновіть її перед скасуванням.</p>}
                {!forbidden && <button className="secondary-button" disabled={busy || loading} onClick={refresh}>Спробувати ще раз</button>}
              </div>}
              {loaded && !loading && !loadError && orders.length === 0 && <p className="profile-card">У вас поки немає заявок. Створіть першу.</p>}
              {!forbidden && orders.map((order) => (
                <article className="profile-card order-card" key={order.id} aria-label={order.title}>
                  <div className="order-card-heading"><h3>{order.title}</h3><span className={`order-status status-${order.status.toLowerCase()}`}>{statuses[order.status]}</span></div>
                  <p className="order-meta">{order.type === "STANDARD" ? "Замовлення послуги" : "Індивідуальна заявка"}</p>
                  <p className="order-description">{order.description}</p>
                  <p className="order-meta">{order.city} · {categories[order.category]}</p>
                  <p className="order-meta">{order.type === "STANDARD"
                    ? order.priceAtOrder == null ? "Ціна за домовленістю" : `Ціна на момент замовлення: ${order.priceAtOrder.replace(".", ",")} грн`
                    : order.budget === null ? "Бюджет не вказано" : `${order.budget.replace(".", ",")} грн`}</p>
                  {order.assignedMaster && <p className="notice">Виконавець: {order.assignedMaster.name}</p>}
                  {order.status === "COMPLETED" && order.completedAt && <p className="order-meta">Завершено: <time dateTime={order.completedAt}>{new Date(order.completedAt).toLocaleString("uk-UA")}</time></p>}
                  {order.type === "CUSTOM" && <ClientOffers order={order} onOrderChange={updateFromOffers} />}
                  <div className="order-card-footer">
                    <time dateTime={order.createdAt}>{new Date(order.createdAt).toLocaleString("uk-UA")}</time>
                    <Link className="nav-link" to={`/orders/${order.id}`}>Переглянути деталі</Link>
                    {canCancel(order.status) && <button className="secondary-button" disabled={busy || loading || historyStale} onClick={() => setPendingCancel(order)}>{cancelling === order.id ? "Скасовуємо…" : "Скасувати заявку"}</button>}
                  </div>
                </article>
              ))}
            </div>
          </div>
      {pendingCancel && <CancelOrderDialog title={pendingCancel.title} onDismiss={() => setPendingCancel(null)}
        onConfirm={() => { const id = pendingCancel.id; setPendingCancel(null); void cancel(id); }} />}
    </section>
  );
}
