import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "./api";
import { useAuth } from "./auth";
import { categories, statuses, type Order } from "./orders";

interface TimelineEvent {
  status: Order["status"];
  at: string | null;
  source?: "database" | "legacy_migration";
}
interface Details extends Order { timeline: TimelineEvent[] }
type View = { state: "loading" } | { state: "ready"; order: Details }
  | { state: "error"; status: number; message: string };

function DateTime({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString("uk-UA")}</time>;
}

export function OrderDetailsPage({ audience }: { audience: "CLIENT" | "MASTER" }) {
  const { id = "" } = useParams();
  const { token } = useAuth();
  // Route/account changes remount the resource: no frame of another order or
  // session's cached details, even before the next effect starts.
  return <DetailsResource key={`${audience}:${id}:${token}`} id={id} audience={audience} />;
}

function DetailsResource({ id, audience }: { id: string; audience: "CLIENT" | "MASTER" }) {
  const { token, logout } = useAuth();
  const [view, setView] = useState<View>({ state: "loading" });
  const current = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const prefix = audience === "CLIENT" ? "/orders" : "/master/orders";
  const load = useCallback(async () => {
    const request = ++current.current;
    controller.current?.abort();
    const next = new AbortController(); controller.current = next;
    setView({ state: "loading" });
    try {
      const data = await api<{ order: Details }>(`${prefix}/${encodeURIComponent(id)}`, { token: token!, signal: next.signal });
      if (next.signal.aborted || request !== current.current) return;
      if (!data.order) { setView({ state: "error", status: 404, message: "Заявку не знайдено або вона недоступна." }); return; }
      setView({ state: "ready", order: data.order });
    } catch (cause) {
      if (next.signal.aborted || request !== current.current) return;
      if (cause instanceof ApiError && cause.status === 401) { logout(true); return; }
      const status = cause instanceof ApiError ? cause.status : 0;
      setView({ state: "error", status, message: status === 403 ? "Немає дозволу переглядати цю заявку."
        : status === 404 ? "Заявку не знайдено або вона недоступна."
        : cause instanceof Error ? cause.message : "Не вдалося завантажити деталі заявки." });
    }
  }, [id, prefix, token, logout]);
  useEffect(() => { void load(); return () => { current.current++; controller.current?.abort(); }; }, [load]);

  const order = view.state === "ready" ? view.order : null;
  return <section className="orders-page order-details-page" aria-label="Деталі замовлення">
    <div className="orders-heading"><h1>Деталі замовлення</h1><Link className="nav-link" to={audience === "CLIENT" ? "/orders" : "/dashboard"}>До моїх замовлень</Link></div>
    <button className="secondary-button" disabled={view.state === "loading"} onClick={() => void load()}>
      {view.state === "error" ? "Спробувати ще раз" : "Оновити деталі"}
    </button>
    {view.state === "loading" && <p role="status">Завантажуємо деталі замовлення…</p>}
    {view.state === "error" && <p className="notice error" role="alert">{view.message}</p>}
    {order && <>
      <article className="profile-card order-card" aria-label={order.title}>
        <div className="order-card-heading"><h2>{order.title}</h2><span className={`order-status status-${order.status.toLowerCase()}`}>{statuses[order.status]}</span></div>
        <p className="order-meta">{order.type === "STANDARD" ? "Замовлення послуги · STANDARD" : "Індивідуальна заявка · CUSTOM"}</p>
        <p className="order-description">{order.description}</p>
        <dl className="order-details-info">
          <div><dt>Номер</dt><dd>{order.id}</dd></div>
          <div><dt>Місто</dt><dd>{order.city}</dd></div>
          <div><dt>Категорія</dt><dd>{categories[order.category]}</dd></div>
          <div><dt>{order.type === "STANDARD" ? "Ціна на момент замовлення" : "Бюджет"}</dt>
            <dd>{order.type === "STANDARD" ? order.priceAtOrder == null ? "Ціна за домовленістю" : `${order.priceAtOrder.replace(".", ",")} грн`
              : order.budget === null ? "Бюджет не вказано" : `${order.budget.replace(".", ",")} грн`}</dd></div>
          <div><dt>Створено</dt><dd><DateTime value={order.createdAt} /></dd></div>
          {order.updatedAt && <div><dt>Оновлено</dt><dd><DateTime value={order.updatedAt} /></dd></div>}
          <div><dt>Виконавець</dt><dd>{order.assignedMaster?.name ?? "Ще не призначено"}</dd></div>
          {order.status === "COMPLETED" && <div><dt>Завершено</dt><dd>{order.completedAt ? <DateTime value={order.completedAt} /> : "Час завершення не збережено"}</dd></div>}
        </dl>
        {audience === "CLIENT" && order.type === "CUSTOM" && <p><Link to="/orders">Переглянути пропозиції у моїх заявках</Link></p>}
      </article>
      <section className="profile-card" aria-labelledby="order-timeline-title">
        <h2 id="order-timeline-title">Історія статусів</h2>
        <p className="order-meta">Події, збережені в історії замовлення.</p>
        {order.timeline.length === 0 ? <p>Історію статусів не збережено.</p> : <ol className="order-timeline" aria-label="Історія статусів">
          {order.timeline.map((event, index) => <li key={index}>
            <strong>{statuses[event.status]}</strong>
            <span>{event.at ? <DateTime value={event.at} /> : "Час події не збережено"}</span>
            {event.source === "database" && <small>Запис БД</small>}
            {event.source === "legacy_migration" && <small>Історичний стан, зафіксований під час міграції</small>}
          </li>)}
        </ol>}
        {order.timeline.some((event) => event.at === null) && <p className="order-meta">Події без відомого часу наведені після датованих; їхній час не відновлювався.</p>}
      </section>
    </>}
  </section>;
}
