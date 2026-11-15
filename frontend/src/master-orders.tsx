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
      if (next.signal.aborted || request !== current.current) return;
      setOrders(data.orders); setForbidden(false);
    } catch (cause) {
      if (next.signal.aborted || request !== current.current) return;
      if (cause instanceof ApiError && cause.status === 401) logout(true);
      else { setForbidden(cause instanceof ApiError && cause.status === 403); setError(cause instanceof Error ? cause.message : "Не вдалося завантажити заявки."); }
    } finally { if (request === current.current && !next.signal.aborted) setLoading(false); }
  }, [token, logout, path]);
  useEffect(() => { void load(); return () => { current.current++; controller.current?.abort(); }; }, [load]);
  return { orders, setOrders, loading, error, forbidden, load };
}
function OrderDetails({ order }: { order: MasterOrder }) {
  return <>
    <div className="order-card-heading"><h3>{order.title}</h3><span className={`order-status status-${order.status.toLowerCase()}`}>{statuses[order.status]}</span></div>
    <p className="order-description">{order.description}</p>
    <p className="order-meta">{order.city} · {categories[order.category]}</p>
    <p className="order-meta">{order.budget === null ? "Бюджет не вказано" : `${order.budget} грн`}</p>
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
  const { orders, loading, error, forbidden, load } = useMasterOrders("assigned");
  return <section className="assigned-orders" aria-label="Призначені заявки">
    <div className="orders-list-heading"><h2>Призначені мені заявки</h2><button className="secondary-button" disabled={loading || forbidden} onClick={() => void load()}>Оновити призначення</button></div>
    {loading && <p role="status">Завантажуємо призначення…</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {!loading && !error && orders.length === 0 && <p>Призначених заявок поки немає.</p>}
    {!forbidden && orders.map((order) => <article className="profile-card order-card" key={order.id} aria-label={order.title}><OrderDetails order={order} /></article>)}
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
