import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "./api";
import { useAuth } from "./auth";
import { categories, statuses, type Order } from "./orders";
import type { CatalogPageData } from "./services-types";

interface Preview { service: CatalogPageData["services"][number]; snapshot: string }
export function StandardOrderPage() {
  const { serviceId = "" } = useParams(); const { token, logout } = useAuth();
  const [preview, setPreview] = useState<Preview | null>(null); const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(false); const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState(""); const [error, setError] = useState(""); const [fields, setFields] = useState<Record<string, string>>({});
  const [description, setDescription] = useState(""); const [cityConfirmed, setCityConfirmed] = useState(false);
  const [saving, setSaving] = useState(false); const [created, setCreated] = useState<Order | null>(null);
  const [uncertain, setUncertain] = useState(false); const [history, setHistory] = useState<Order[]>([]);
  const [historyChecked, setHistoryChecked] = useState(false); const [checking, setChecking] = useState(false);
  const [historyError, setHistoryError] = useState(""); const [retryConfirmed, setRetryConfirmed] = useState(false);
  const active = useRef(true); const lock = useRef(false); const request = useRef(0); const controller = useRef<AbortController | null>(null);
  function permission(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 401) logout(true);
    if (cause instanceof ApiError && cause.status === 403) { setForbidden(true); setError(cause.message); }
    return cause instanceof Error ? cause.message : "Не вдалося виконати запит.";
  }
  const load = useCallback(async () => {
    const id = ++request.current; controller.current?.abort(); const next = new AbortController(); controller.current = next;
    setLoading(true); setLoadError(""); setAvailable(false); setCityConfirmed(false);
    try {
      const data = await api<Preview>(`/orders/standard/${encodeURIComponent(serviceId)}`, { token: token!, signal: next.signal });
      if (next.signal.aborted || id !== request.current) return;
      setPreview(data); setAvailable(true); setForbidden(false);
    } catch (cause) {
      if (next.signal.aborted || id !== request.current) return;
      if (cause instanceof ApiError && cause.status === 401) logout(true);
      else { if (cause instanceof ApiError && cause.status === 403) setForbidden(true); setLoadError(cause instanceof Error ? cause.message : "Не вдалося завантажити послугу."); }
    } finally { if (!next.signal.aborted && id === request.current) setLoading(false); }
  }, [serviceId, token, logout]);
  useEffect(() => {
    active.current = true; setPreview(null); setDescription(""); setCreated(null); setError(""); setFields({}); setUncertain(false); setHistoryChecked(false); setRetryConfirmed(false); setHistory([]);
    void load(); return () => { active.current = false; request.current++; controller.current?.abort(); };
  }, [load]);
  async function checkHistory() {
    setChecking(true); setHistoryError(""); setHistoryChecked(false); setRetryConfirmed(false);
    try {
      const data = await api<{ orders: Order[] }>("/orders", { token: token! });
      if (active.current) { setHistory(data.orders.filter((row) => row.type === "STANDARD" && row.serviceId === serviceId).slice(0, 5)); setHistoryChecked(true); }
    } catch (cause) { if (active.current) setHistoryError(permission(cause)); }
    finally { if (active.current) setChecking(false); }
  }
  const disabled = saving || loading || checking || !available || forbidden || (uncertain && (!historyChecked || !retryConfirmed));
  async function submit(event: FormEvent) {
    event.preventDefault(); if (lock.current || disabled || !preview || !cityConfirmed) return;
    if (!description.trim()) { setFields({ description: "Опишіть проблему." }); return; }
    lock.current = true; setSaving(true); setError(""); setFields({});
    try {
      const data = await api<{ order: Order }>("/orders/standard", { method: "POST", token: token!, body: { serviceId, description, expectedSnapshot: preview.snapshot } });
      if (active.current) setCreated(data.order);
    } catch (cause) {
      if (!active.current) return;
      setError(permission(cause)); setFields(cause instanceof ApiError ? cause.fields ?? {} : {});
      if (cause instanceof ApiError && cause.status === 409) await load();
      else if (cause instanceof ApiError && cause.status === 404) { setAvailable(false); setCityConfirmed(false); }
      else if (!(cause instanceof ApiError) || ![400, 401, 403].includes(cause.status)) {
        setUncertain(true); setHistoryChecked(false); setRetryConfirmed(false); setCityConfirmed(false);
        await load();
      }
    } finally { lock.current = false; if (active.current) setSaving(false); }
  }
  return <section className="orders-page standard-order-page">
    <div className="orders-heading"><h1>Замовлення послуги</h1><Link className="nav-link" to="/catalog">До каталогу</Link></div>
    {created ? <div className="profile-card">
      <p className="notice" role="status">Замовлення створено. Статус: {statuses[created.status]}.</p><h2>{created.title}</h2>
      <p>{created.city} · {created.priceAtOrder == null ? "Ціна за домовленістю" : `${created.priceAtOrder} грн`}</p>
      <Link className="nav-button" to="/orders">Переглянути мої замовлення</Link>
    </div> : <>
      {loading && <p role="status">Завантажуємо дані послуги…</p>}
      {loadError && <p role="alert" className="notice error">{loadError}</p>}
      {error && <p role="alert" className="notice error">{error}</p>}
      {!forbidden && <button className="secondary-button" disabled={loading || saving || checking} onClick={() => void load()}>Оновити дані послуги</button>}
      {!forbidden && preview && <form className="profile-card standard-form" aria-label="STANDARD-замовлення" onSubmit={submit}>
        <h2>{preview.service.title}</h2><p>Майстер: {preview.service.master.name}</p>
        <p>Місто надання послуги: <strong>{preview.service.master.city}</strong></p><p>{categories[preview.service.category]}</p>
        <p>{preview.service.priceEstimate === null ? "Ціна за домовленістю" : `Орієнтовна ціна: ${preview.service.priceEstimate.replace(".", ",")} грн`}</p>
        <label htmlFor="standard-description">Опис проблеми</label>
        <textarea id="standard-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={5} required maxLength={4000} disabled={saving} aria-invalid={!!fields.description} aria-describedby={fields.description ? "standard-description-error standard-description-help" : "standard-description-help"} />
        <p id="standard-description-help" className="order-meta">За потреби вкажіть район у тексті. Точна адреса на цьому етапі не потрібна.</p>
        {fields.description && <span id="standard-description-error" className="field-error">{fields.description}</span>}
        <label className="confirmation"><input type="checkbox" required checked={cityConfirmed} disabled={saving || loading || !available} onChange={(event) => setCityConfirmed(event.target.checked)} />Підтверджую, що замовляю роботу в місті {preview.service.master.city}</label>
        <button className="primary-button" disabled={disabled || !cityConfirmed}>{saving ? "Надсилаємо замовлення…" : "Підтвердити замовлення"}</button>
      </form>}
      {!forbidden && uncertain && <section className="profile-card" aria-label="Перевірка історії перед повтором">
        <p className="notice">Відповідь не отримано однозначно. Замовлення могло бути створене. Перевірте історію перед ручним повтором.</p>
        <button className="secondary-button" disabled={checking || saving} onClick={() => void checkHistory()}>Перевірити мою історію</button>
        {checking && <p role="status">Перевіряємо історію…</p>}{historyError && <p role="alert">{historyError}</p>}
        {historyChecked && <>
          <h2>Останні замовлення цієї послуги</h2>{history.length === 0 && <p>Замовлень цієї послуги в історії немає.</p>}
          {history.map((row) => <article className="offer-card" key={row.id}><strong>{row.title}</strong><p>{row.description}</p><p>{statuses[row.status]} · <time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString("uk-UA")}</time></p><p className="order-meta">Номер: {row.id}</p></article>)}
          <label className="confirmation"><input type="checkbox" checked={retryConfirmed} onChange={(event) => setRetryConfirmed(event.target.checked)} />Я перевірив історію та свідомо підтверджую повторне надсилання</label>
        </>}
        <Link className="nav-link" to="/orders">Повна історія замовлень</Link>
      </section>}
    </>}
  </section>;
}
