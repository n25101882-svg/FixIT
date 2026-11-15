import { useEffect, useRef, useState } from "react";
import { api, ApiError, type ServiceCategory } from "./api";
import { useAuth } from "./auth";
import type { Order } from "./orders";

export interface PublicMaster {
  id: string;
  name: string;
  city: string;
  category: ServiceCategory;
  description: string | null;
}
interface Offer {
  id: string;
  message: string;
  proposedPrice: string | null;
  master: PublicMaster;
}
export function ClientOffers({ order, onOrderChange }: {
  order: Order;
  onOrderChange: (order: Order, selected?: boolean) => void;
}) {
  const { token, logout } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [stale, setStale] = useState(true);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const active = useRef(true);
  const requestId = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; requestId.current++; }; }, []);

  function handleError(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 401) logout(true);
    return cause instanceof Error ? cause.message : "Не вдалося отримати пропозиції.";
  }
  async function load() {
    const id = ++requestId.current;
    setLoading(true); setLoadError(""); setStale(true);
    try {
      const data = await api<{ order: Order; responses: Offer[] }>(`/orders/${order.id}/responses`, { token: token! });
      if (!active.current || id !== requestId.current) return;
      setOffers(data.responses); setLoaded(true); setStale(false); onOrderChange(data.order);
    } catch (cause) {
      if (active.current && id === requestId.current) setLoadError(handleError(cause));
    } finally { if (active.current && id === requestId.current) setLoading(false); }
  }
  async function select(responseId: string) {
    setChoosing(true); setError("");
    try {
      const data = await api<{ order: Order }>(`/orders/${order.id}/select-response`, {
        method: "POST", token: token!, body: { responseId },
      });
      if (active.current) onOrderChange(data.order, true);
    } catch (cause) {
      if (!active.current) return;
      setError(handleError(cause));
      if (cause instanceof ApiError && cause.status === 409) await load();
    } finally { if (active.current) setChoosing(false); }
  }
  return <section className="client-offers" aria-label={`Пропозиції: ${order.title}`}>
    <button className="secondary-button" aria-expanded={expanded} onClick={() => {
      setExpanded(!expanded); if (!expanded && !loaded) void load();
    }}>Переглянути пропозиції</button>
    {expanded && <div>
      <div className="orders-list-heading"><h4>Пропозиції майстрів</h4>
        <button className="secondary-button" disabled={loading || choosing} onClick={() => void load()}>Оновити пропозиції</button></div>
      {loading && <p role="status">Завантажуємо пропозиції…</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {loadError && <p className="notice error" role="alert">{loadError} Повторіть оновлення пропозицій.</p>}
      {loaded && !loading && !loadError && offers.length === 0 && <p>Пропозицій поки немає.</p>}
      {offers.map((offer) => <article className="offer-card" key={offer.id} aria-label={`Пропозиція від ${offer.master.name}`}>
        <h4>{offer.master.name}</h4><p className="order-meta">{offer.master.city}</p>
        <p className="order-description">{offer.master.description}</p>
        <p className="order-description">{offer.message}</p>
        {offer.proposedPrice !== null && <p>Орієнтовна ціна: {offer.proposedPrice} грн</p>}
        {order.masterProfileId === offer.master.id ? <p className="notice">Обраний виконавець</p>
          : order.status === "OPEN" && !order.masterProfileId && <button className="secondary-button"
            disabled={choosing || loading || stale} onClick={() => void select(offer.id)}>{choosing ? "Обираємо…" : "Обрати майстра"}</button>}
      </article>)}
    </div>}
  </section>;
}
