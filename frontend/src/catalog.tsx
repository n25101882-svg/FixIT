import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "./api";
import { categories } from "./orders";
import type { PublicMaster } from "./ClientOffers";
import type { CatalogPageData, MasterPageData, Page, Service } from "./services-types";

function usePublicPage<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({}); const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(""); setFields({});
    void api<T>(path, { signal: controller.signal }).then((value) => { if (!controller.signal.aborted) setData(value); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "Не вдалося завантажити каталог."); setFields(cause instanceof ApiError ? cause.fields ?? {} : {}); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, attempt]);
  return { data, loading, error, fields, retry: () => setAttempt((value) => value + 1) };
}
function Pagination({ data, loading, onPage }: { data: Page; loading: boolean; onPage: (page: number) => void }) {
  return data.totalPages > 1 && <nav className="catalog-pagination" aria-label="Сторінки послуг">
    <button className="secondary-button" disabled={loading || data.page <= 1} onClick={() => onPage(data.page - 1)}>Попередня</button>
    <span>Сторінка {data.page} з {data.totalPages}</span>
    <button className="secondary-button" disabled={loading || data.page >= data.totalPages} onClick={() => onPage(data.page + 1)}>Наступна</button>
  </nav>;
}
function ServiceCard({ service, master }: { service: Service; master: PublicMaster }) {
  return <article className="profile-card service-card" aria-label={service.title}>
    <p className="eyebrow">{categories[service.category]}</p><h2>{service.title}</h2>
    <Link className="nav-link" to={`/masters/${master.id}`}>Майстер: {master.name}</Link>
    <p className="order-meta">{master.city}</p><p className="service-excerpt">{service.description || "Опис послуги не вказано."}</p>
    <p className="service-price">{service.priceEstimate === null ? "Ціна за домовленістю" : `${service.priceEstimate.replace(".", ",")} грн`}</p>
    <button className="secondary-button" disabled data-service-id={service.id} aria-describedby={`future-${service.id}`}>Замовити послугу</button>
    <p className="order-meta" id={`future-${service.id}`}>Онлайн-замовлення послуг буде доступне згодом.</p>
  </article>;
}
export function CatalogPage() {
  const [search, setSearch] = useSearchParams();
  const { data, loading, error, fields, retry } = usePublicPage<CatalogPageData>(`/catalog/services?${search.toString()}`);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget); const next = new URLSearchParams();
    for (const name of ["city", "category", "q"]) { const value = String(values.get(name) ?? "").trim(); if (value) next.set(name, value); }
    if (next.toString() === search.toString()) retry(); else setSearch(next);
  }
  const fieldError = (name: string) => fields[name] && <span className="field-error" id={`catalog-${name}-error`}>{fields[name]}</span>;
  return <section className="catalog-page">
    <span className="eyebrow">FIXIT · ПОСЛУГИ ПОРУЧ</span><h1>Знайдіть свого майстра</h1>
    <p className="orders-intro">Оберіть послугу у своєму місті та дізнайтеся більше про майстра.</p>
    <form className="profile-card catalog-filters" aria-label="Пошук послуг" onSubmit={submit} key={search.toString()}>
      <div><label htmlFor="catalog-q">Пошук послуг</label><input id="catalog-q" name="q" maxLength={120} defaultValue={search.get("q") ?? ""} aria-invalid={!!fields.q} aria-describedby={fields.q ? "catalog-q-error" : undefined} />{fieldError("q")}</div>
      <div><label htmlFor="catalog-city">Місто</label><input id="catalog-city" name="city" maxLength={100} defaultValue={search.get("city") ?? ""} aria-invalid={!!fields.city} aria-describedby={fields.city ? "catalog-city-error" : undefined} />{fieldError("city")}</div>
      <div><label htmlFor="catalog-category">Категорія</label><select id="catalog-category" name="category" defaultValue={search.get("category") ?? ""} aria-invalid={!!fields.category} aria-describedby={fields.category ? "catalog-category-error" : undefined}>
        <option value="">Усі категорії</option>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>{fieldError("category")}</div>
      <button className="primary-button" disabled={loading}>Знайти послуги</button>
    </form>
    <div className="orders-list-heading"><h2>Каталог послуг</h2><button className="secondary-button" disabled={loading} onClick={retry}>Оновити каталог</button></div>
    {loading && <p role="status">Завантажуємо послуги…</p>}
    {error && <div className="notice error"><p role="alert">{error}</p><button className="secondary-button" onClick={retry}>Спробувати ще раз</button></div>}
    {!loading && !error && data && <>
      <p role="status">Знайдено послуг: {data.total}</p>
      {data.services.length === 0 && <p className="profile-card">Послуг за цими умовами поки немає. Спробуйте змінити пошук.</p>}
      <div className="catalog-grid">{data.services.map((service) => <ServiceCard key={service.id} service={service} master={service.master} />)}</div>
      <Pagination data={data} loading={loading} onPage={(page) => { const next = new URLSearchParams(search); next.set("page", String(page)); setSearch(next); }} />
    </>}
  </section>;
}
export function PublicMasterPage() {
  const { id } = useParams(); const [search, setSearch] = useSearchParams();
  const { data, loading, error, retry } = usePublicPage<MasterPageData>(`/catalog/masters/${encodeURIComponent(id ?? "")}?${search.toString()}`);
  return <section className="catalog-page">
    <Link className="nav-link" to="/catalog">До каталогу</Link>
    {loading && <p role="status">Завантажуємо профіль майстра…</p>}
    {error && <div className="notice error"><p role="alert">{error}</p><button className="secondary-button" onClick={retry}>Спробувати ще раз</button></div>}
    {!loading && !error && data && <>
      <div className="profile-card public-master"><span className="eyebrow">МАЙСТЕР FIXIT</span><h1>{data.master.name}</h1>
        <p>{data.master.city} · Основна категорія: {categories[data.master.category]}</p><p className="order-description">{data.master.description || "Майстер ще не додав опис."}</p></div>
      <h2>Активні послуги</h2>{data.services.length === 0 && <p>Активних послуг поки немає.</p>}
      <div className="catalog-grid">{data.services.map((service) => <ServiceCard key={service.id} service={service} master={data.master} />)}</div>
      <Pagination data={data} loading={loading} onPage={(page) => { const next = new URLSearchParams(search); next.set("page", String(page)); setSearch(next); }} />
    </>}
  </section>;
}
