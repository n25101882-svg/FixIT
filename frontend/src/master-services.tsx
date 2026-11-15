import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type ServiceCategory } from "./api";
import { useAuth } from "./auth";
import { categories } from "./orders";
import type { PublicMaster } from "./ClientOffers";
import type { Service } from "./services-types";

type ServiceInput = { title: string; category: ServiceCategory; description: string | null; priceEstimate: string | null };
type ProfileInput = { city: string; category: ServiceCategory; description: string | null };
function useFormError() {
  const [error, setError] = useState(""); const [fields, setFields] = useState<Record<string, string>>({});
  return { error, fields, clear: () => { setError(""); setFields({}); }, fail: (cause: unknown) => {
    setError(cause instanceof Error ? cause.message : "Не вдалося зберегти зміни."); setFields(cause instanceof ApiError ? cause.fields ?? {} : {});
  } };
}
function ProfileForm({ profile, disabled, save }: { profile: PublicMaster; disabled: boolean; save: (body: ProfileInput) => Promise<PublicMaster> }) {
  const [city, setCity] = useState(profile.city); const [category, setCategory] = useState(profile.category); const [description, setDescription] = useState(profile.description ?? "");
  const dirty = useRef(false);
  const { error, fields, clear, fail } = useFormError();
  useEffect(() => { if (!dirty.current) { setCity(profile.city); setCategory(profile.category); setDescription(profile.description ?? ""); } }, [profile]);
  async function submit(event: FormEvent) { event.preventDefault(); clear(); try { const updated = await save({ city, category, description: description.trim() || null }); dirty.current = false; setCity(updated.city); setCategory(updated.category); setDescription(updated.description ?? ""); } catch (cause) { fail(cause); } }
  return <form className="profile-card" aria-label="Мій профіль майстра" onSubmit={submit}>
    <h2>Мій профіль майстра</h2><p>{profile.name}</p>
    {error && <p role="alert" className="notice error">{error}</p>}
    <fieldset className="order-fields" disabled={disabled}>
      <label htmlFor="profile-city">Місто профілю</label><input id="profile-city" value={city} onChange={(event) => { dirty.current = true; setCity(event.target.value); }} required maxLength={100} aria-invalid={!!fields.city} aria-describedby={fields.city ? "profile-city-error" : undefined} />
      {fields.city && <span id="profile-city-error" className="field-error">{fields.city}</span>}
      <label htmlFor="profile-category">Основна категорія</label><select id="profile-category" value={category} onChange={(event) => { dirty.current = true; setCategory(event.target.value as ServiceCategory); }} aria-invalid={!!fields.category} aria-describedby={fields.category ? "profile-category-error" : undefined}>
        {Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>{fields.category && <span id="profile-category-error" className="field-error">{fields.category}</span>}
      <label htmlFor="profile-description">Опис профілю</label><textarea id="profile-description" rows={4} value={description} onChange={(event) => { dirty.current = true; setDescription(event.target.value); }} maxLength={2000} aria-invalid={!!fields.description} aria-describedby={fields.description ? "profile-description-error" : undefined} />
      {fields.description && <span id="profile-description-error" className="field-error">{fields.description}</span>}
    </fieldset><button className="primary-button" disabled={disabled}>Зберегти профіль</button>
  </form>;
}
function ServiceForm({ service, disabled, save, dismiss }: { service: Service | null; disabled: boolean; save: (body: ServiceInput) => Promise<void>; dismiss: () => void }) {
  const prefix = useId(); const { error, fields, clear, fail } = useFormError();
  const [title, setTitle] = useState(service?.title ?? ""); const [category, setCategory] = useState<ServiceCategory>(service?.category ?? "OTHER");
  const [description, setDescription] = useState(service?.description ?? ""); const [priceEstimate, setPrice] = useState(service?.priceEstimate ?? "");
  async function submit(event: FormEvent) {
    event.preventDefault(); clear();
    try { await save({ title, category, description: description.trim() || null, priceEstimate: priceEstimate.trim() || null });
      if (!service) { setTitle(""); setDescription(""); setPrice(""); setCategory("OTHER"); }
    } catch (cause) { fail(cause); }
  }
  const fieldError = (name: string) => fields[name] && <span className="field-error" id={`${prefix}-${name}-error`}>{fields[name]}</span>;
  return <form className="profile-card" aria-label={service ? "Редагування послуги" : "Нова послуга"} onSubmit={submit}>
    <h2>{service ? "Редагування послуги" : "Нова послуга"}</h2>{error && <p role="alert" className="notice error">{error}</p>}
    <fieldset className="order-fields" disabled={disabled}>
      <label htmlFor={`${prefix}-title`}>Назва послуги</label><input id={`${prefix}-title`} required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} aria-invalid={!!fields.title} aria-describedby={fields.title ? `${prefix}-title-error` : undefined} />{fieldError("title")}
      <label htmlFor={`${prefix}-category`}>Категорія послуги</label><select id={`${prefix}-category`} value={category} onChange={(event) => setCategory(event.target.value as ServiceCategory)} aria-invalid={!!fields.category} aria-describedby={fields.category ? `${prefix}-category-error` : undefined}>
        {Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>{fieldError("category")}
      <label htmlFor={`${prefix}-description`}>Опис послуги</label><textarea id={`${prefix}-description`} rows={4} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} aria-invalid={!!fields.description} aria-describedby={fields.description ? `${prefix}-description-error` : undefined} />{fieldError("description")}
      <label htmlFor={`${prefix}-priceEstimate`}>Орієнтовна ціна, грн (необов’язково)</label><input id={`${prefix}-priceEstimate`} inputMode="decimal" maxLength={11} value={priceEstimate} onChange={(event) => setPrice(event.target.value)} aria-invalid={!!fields.priceEstimate} aria-describedby={fields.priceEstimate ? `${prefix}-priceEstimate-error` : undefined} />{fieldError("priceEstimate")}
    </fieldset><button className="primary-button" disabled={disabled}>{service ? "Зберегти послугу" : "Створити послугу"}</button>
    {service && <button type="button" className="secondary-button" disabled={disabled} onClick={dismiss}>Скасувати редагування</button>}
  </form>;
}
export function MasterServicesPage() {
  const { token, logout } = useAuth(); const [profile, setProfile] = useState<PublicMaster | null>(null); const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState(""); const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false); const [stale, setStale] = useState(false); const [editing, setEditing] = useState<Service | null>(null);
  const [notice, setNotice] = useState(""); const [actionError, setActionError] = useState(""); const lock = useRef(false);
  const current = useRef(0); const controller = useRef<AbortController | null>(null); const active = useRef(true);
  const load = useCallback(async () => {
    const id = ++current.current; controller.current?.abort(); const next = new AbortController(); controller.current = next; setLoading(true); setLoadError("");
    try {
      const [p, s] = await Promise.all([api<{ profile: PublicMaster }>("/master/profile", { token: token!, signal: next.signal }), api<{ services: Service[] }>("/master/services", { token: token!, signal: next.signal })]);
      if (id !== current.current || next.signal.aborted) return;
      setProfile(p.profile); setServices(s.services); setForbidden(false); setStale(false);
    } catch (cause) {
      if (id !== current.current || next.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 401) logout(true);
      else { setLoadError(cause instanceof Error ? cause.message : "Не вдалося завантажити послуги."); if (cause instanceof ApiError && cause.status === 403) setForbidden(true); }
    } finally { if (id === current.current && !next.signal.aborted) setLoading(false); }
  }, [token, logout]);
  useEffect(() => { active.current = true; void load(); return () => { active.current = false; current.current++; controller.current?.abort(); }; }, [load]);
  async function mutate<T>(path: string, method: "POST" | "PATCH", body: unknown): Promise<T> {
    if (lock.current) throw new ApiError(409, "Зачекайте завершення попереднього запиту.");
    lock.current = true; setBusy(true); setNotice(""); setActionError("");
    try { return await api<T>(path, { method, token: token!, body }); }
    catch (cause) { if (cause instanceof ApiError && cause.status === 401) logout(true);
      if (cause instanceof ApiError && cause.status === 403) setForbidden(true);
      if (cause instanceof ApiError && (cause.status === 0 || cause.status >= 500 || cause.status === 409)) setStale(true);
      throw cause;
    } finally { lock.current = false; if (active.current) setBusy(false); }
  }
  const disabled = loading || busy || stale || !!loadError;
  return <section className="orders-page management-page">
    <div className="orders-heading"><h1>Профіль і послуги</h1><Link className="nav-link" to="/dashboard">До кабінету</Link></div>
    <button className="secondary-button" disabled={loading || busy || forbidden} onClick={() => void load()}>Оновити мої дані</button>
    {loading && <p role="status">Завантажуємо профіль і послуги…</p>}{loadError && <p role="alert" className="notice error">{loadError}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}{actionError && <p role="alert" className="notice error">{actionError}</p>}
    {stale && <p className="notice">Оновіть мої дані перед повторним збереженням: попередній запит міг бути виконаний.</p>}
    {!forbidden && profile && <>
      <div className="management-grid"><ProfileForm profile={profile} disabled={disabled} save={async (body) => {
        const result = await mutate<{ profile: PublicMaster }>("/master/profile", "PATCH", body);
        if (active.current) { setProfile(result.profile); setNotice("Профіль оновлено."); }
        return result.profile;
      }} /><ServiceForm key={editing?.id ?? "new"} service={editing} disabled={disabled} dismiss={() => setEditing(null)} save={async (body) => {
        const result = await mutate<{ service: Service }>(editing ? `/master/services/${editing.id}` : "/master/services", editing ? "PATCH" : "POST", body);
        if (active.current) { setServices((rows) => editing ? rows.map((row) => row.id === result.service.id ? result.service : row) : [result.service, ...rows]); setNotice(editing ? "Послугу оновлено." : "Послугу створено."); setEditing(null); }
      }} /></div>
      <h2>Мої послуги</h2>{!loading && services.length === 0 && <p>Послуг поки немає. Створіть першу.</p>}
      <div className="catalog-grid">{services.map((service) => <article className="profile-card service-card" key={service.id} aria-label={service.title}>
        <h3>{service.title}</h3><span className="order-status">{service.isActive ? "Активна" : "Прихована"}</span><p>{categories[service.category]}</p>
        <p className="order-description">{service.description}</p><p>{service.priceEstimate === null ? "Ціна не вказана" : `${service.priceEstimate} грн`}</p>
        <div className="service-actions"><button className="secondary-button" disabled={disabled} onClick={() => setEditing(service)}>Редагувати</button>
          <button className="secondary-button" disabled={disabled} onClick={() => { void mutate<{ service: Service }>(`/master/services/${service.id}`, "PATCH", { isActive: !service.isActive }).then(({ service: updated }) => {
            if (active.current) { setServices((rows) => rows.map((row) => row.id === updated.id ? updated : row)); setNotice(updated.isActive ? "Послугу активовано." : "Послугу приховано."); }
          }).catch((cause: unknown) => { if (active.current) setActionError(cause instanceof Error ? cause.message : "Не вдалося змінити активність."); }); }}> {service.isActive ? "Приховати" : "Активувати"}</button></div>
      </article>)}</div>
    </>}
  </section>;
}
