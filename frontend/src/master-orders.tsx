import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "./api";
import { useAuth } from "./auth";
import { categories, statuses, type Order } from "./orders";

interface MasterOrder extends Order {
  myResponse?: { id: string; message: string; createdAt: string } | null;
}
function useMasterOrders(path: "available" | "assigned") {
  const { token, logout } = useAuth();
  const [orders, setOrders] = useState<MasterOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const current = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    const request = ++current.current;
    controller.current?.abort();
    const next = new AbortController(); controller.current = next;
    setLoading(true); setError("");
    try {
      const data = await api<{ orders: MasterOrder[] }>(`/master/orders/${path}`, { token: token!, signal: next.signal });
      if (next.signal.aborted || request !== current.current) return false;
      setOrders(data.orders); setForbidden(false);
      return true;
    } catch (cause) {
      if (next.signal.aborted || request !== current.current) return;
      if (cause instanceof ApiError && cause.status === 401) logout(true);
      else { setForbidden(cause instanceof ApiError && cause.status === 403); setError(cause instanceof Error ? cause.message : "Не вдалося завантажити заявки."); }
      return false;
    } finally { if (request === current.current && !next.signal.aborted) setLoading(false); }
  }, [token, logout, path]);
  useEffect(() => { void load(); return () => { current.current++; controller.current?.abort(); }; }, [load]);
  const invalidate = () => { current.current++; controller.current?.abort(); setLoading(false); };
  return { orders, setOrders, loading, error, forbidden, load, invalidate };
}
function OrderDetails({ order }: { order: MasterOrder }) {
  return <>
    <div className="order-card-heading"><h3>{order.title}</h3><span className={`order-status status-${order.status.toLowerCase()}`}>{statuses[order.status]}</span></div>
    <p className="order-description">{order.description}</p>
    <p className="order-meta">{order.city} · {categories[order.category]}</p>
    <p className="order-meta">{order.budget === null ? "Бюджет не вказано" : `${order.budget} грн`}</p>
    {order.status === "COMPLETED" && order.completedAt && <p className="order-meta">Завершено: <time dateTime={order.completedAt}>{new Date(order.completedAt).toLocaleString("uk-UA")}</time></p>}
  </>;
}
function OfferForm({ order, onCreated, onConflict }: { order: MasterOrder; onCreated: (response: NonNullable<MasterOrder["myResponse"]>) => void; onConflict: () => Promise<void> }) {
  const { token, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!message.trim()) { setError("Напишіть текст пропозиції."); return; }
    setBusy(true); setError("");
    try {
      const data = await api<{ response: NonNullable<MasterOrder["myResponse"]> }>(`/master/orders/${order.id}/responses`, {
        method: "POST", token: token!, body: { message },
      });
      onCreated(data.response);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) logout(true);
      else {
        setError(cause instanceof Error ? cause.message : "Не вдалося надіслати пропозицію.");
        if (cause instanceof ApiError && cause.status === 403) setBlocked(true);
        if (cause instanceof ApiError && cause.status === 409) await onConflict();
      }
    } finally { setBusy(false); }
  }
  return <form className="offer-form" aria-label={`Пропозиція: ${order.title}`} onSubmit={submit}>
    <label htmlFor={`offer-${order.id}`}>Ваша пропозиція</label>
    <textarea id={`offer-${order.id}`} required maxLength={2000} rows={3} value={message} onChange={(event) => setMessage(event.target.value)} disabled={busy || blocked} />
    {error && <p role="alert" className="notice error">{error}</p>}
    <button className="secondary-button" disabled={busy || blocked}>{busy ? "Надсилаємо…" : "Надіслати пропозицію"}</button>
  </form>;
}
export function AssignedOrders() {
  const { orders, setOrders, loading, error, forbidden, load, invalidate } = useMasterOrders("assigned");
  const { token, logout } = useAuth();
  const [pending, setPending] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const [uncertain, setUncertain] = useState<Set<string>>(new Set());
  const [mutationError, setMutationError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function refresh() {
    if (await load() && active.current) setUncertain(new Set());
  }
  async function transition(order: MasterOrder, status: "IN_PROGRESS" | "COMPLETED") {
    if (inFlight.current || loading || error || blocked.has(order.id) || uncertain.has(order.id)) return;
    inFlight.current = true; setPending(order.id); setMutationError(""); setNotice("");
    try {
      const data = await api<{ order: MasterOrder }>(`/master/orders/${order.id}/status`, {
        method: "PATCH", token: token!, body: { status },
      });
      if (!active.current) return;
      invalidate();
      setOrders((rows) => rows.map((row) => row.id === order.id ? data.order : row));
      setNotice(status === "IN_PROGRESS" ? "Роботу розпочато." : "Роботу завершено.");
    } catch (cause) {
      if (!active.current) return;
      if (cause instanceof ApiError && cause.status === 401) logout(true);
      else {
        setMutationError(cause instanceof Error ? cause.message : "Не вдалося змінити статус.");
        if (cause instanceof ApiError && cause.status === 403) setBlocked((ids) => new Set(ids).add(order.id));
        else {
          // A lost response may follow a committed PATCH. Reconcile before retry.
          setUncertain((ids) => new Set(ids).add(order.id));
          if (await load() && active.current) setUncertain((ids) => { const next = new Set(ids); next.delete(order.id); return next; });
        }
      }
    } finally { inFlight.current = false; if (active.current) setPending(null); }
  }
  return <section className="assigned-orders" aria-label="Призначені заявки">
    <div className="orders-list-heading"><h2>Призначені мені заявки</h2><button className="secondary-button" disabled={loading || forbidden || pending !== null} onClick={() => void refresh()}>Оновити призначення</button></div>
    {loading && <p role="status">Завантажуємо призначення…</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {mutationError && <p role="alert" className="notice error">{mutationError}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    {!loading && !error && orders.length === 0 && <p>Призначених заявок поки немає.</p>}
    {!forbidden && orders.map((order) => <article className="profile-card order-card" key={order.id} aria-label={order.title}>
      <OrderDetails order={order} />
      {blocked.has(order.id) && <p className="notice error">Немає дозволу змінювати цю заявку.</p>}
      {uncertain.has(order.id) && <p className="notice">Оновіть призначення перед повторною дією.</p>}
      {order.type === "CUSTOM" && ["ACCEPTED", "IN_PROGRESS"].includes(order.status) && <button className="secondary-button"
        disabled={loading || !!error || pending !== null || blocked.has(order.id) || uncertain.has(order.id)}
        onClick={() => void transition(order, order.status === "ACCEPTED" ? "IN_PROGRESS" : "COMPLETED")}>
        {pending === order.id ? "Зберігаємо…" : order.status === "ACCEPTED" ? "Розпочати роботу" : "Завершити роботу"}
      </button>}
    </article>)}
  </section>;
}
export function MasterOrdersPage() {
  const { orders, setOrders, loading, error, forbidden, load } = useMasterOrders("available");
  const [notice, setNotice] = useState("");
  return <section className="orders-page">
    <div className="orders-heading"><h1>Заявки для майстра</h1><Link className="nav-link" to="/dashboard">До кабінету</Link></div>
    <p className="orders-intro">Відкриті CUSTOM-заявки у вашому місті та категорії. Відбір виконує сервер за вашим профілем.</p>
    <button className="secondary-button" disabled={loading || forbidden} onClick={() => void load()}>Оновити стрічку</button>
    {notice && <p role="status" className="notice">{notice}</p>}
    {loading && <p role="status">Завантажуємо доступні заявки…</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {!loading && !error && orders.length === 0 && <p>Відкритих заявок за вашим профілем поки немає.</p>}
    {!forbidden && orders.map((order) => <article className="profile-card order-card" key={order.id} aria-label={order.title}>
      <OrderDetails order={order} />
      {order.myResponse ? <div className="notice"><strong>Пропозицію надіслано</strong><p className="order-description">{order.myResponse.message}</p></div>
        : <OfferForm order={order} onCreated={(response) => {
          setOrders((rows) => rows.map((row) => row.id === order.id ? { ...row, myResponse: response } : row));
          setNotice("Пропозицію надіслано клієнту.");
        }} onConflict={async () => { setNotice("Заявка змінилася або пропозиція вже існує. Перевірте актуальний список."); await load(); }} />}
    </article>)}
  </section>;
}
