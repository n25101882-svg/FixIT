import { useEffect, useState, type FormEvent } from "react";
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { api, ApiError, type LoginResponse, type User } from "./api";
import { useAuth } from "./auth";
import "./styles.css";

const roles = { CLIENT: "Клієнт", MASTER: "Майстер", ADMIN: "Адміністратор" };

function ArrowIcon() {
  return (
    <svg
      className="arrow-icon"
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
    >
      <path
        d="M4 12 12 4M4 4h8v8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Brand() {
  return (
    <Link to="/dashboard" className="brand" aria-label="FixIT — головна">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path
            d="M14.5 6a5 5 0 0 0-6.4 6.4l-5 5a2.4 2.4 0 0 0 3.4 3.4l5-5A5 5 0 0 0 18 9.5l-3 3-3-3 3-3Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span>
        Fix<span className="brand-it">IT</span>
        <span className="brand-dot">.</span>
      </span>
    </Link>
  );
}

function Layout() {
  const { token } = useAuth();
  return (
    <div className="site-shell">
      <header className="site-header">
        <Brand />
        <nav aria-label="Головна навігація">
          {token ? (
            <Link className="nav-link" to="/dashboard">
              Мій простір <ArrowIcon />
            </Link>
          ) : (
            <>
              <Link className="nav-link" to="/login">
                Увійти
              </Link>
              <Link className="nav-button" to="/register">
                Створити акаунт <ArrowIcon />
              </Link>
            </>
          )}
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
      <footer className="site-footer">
        <span>© {new Date().getFullYear()} FixIT</span>
        <span>Дім у надійних руках.</span>
        <span>Зроблено для людей</span>
      </footer>
    </div>
  );
}

function ProtectedRoute() {
  const { token, sessionExpired } = useAuth();
  return token ? (
    <Outlet />
  ) : (
    <Navigate to="/login" replace state={{ expired: sessionExpired }} />
  );
}

function AuthPage({ mode }: { mode: "login" | "register" }) {
  const registration = mode === "register";
  const { token, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  if (token) return <Navigate to="/dashboard" replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setFields({});
    const values = new FormData(event.currentTarget);
    const email = String(values.get("email") ?? "");
    const password = String(values.get("password") ?? "");
    try {
      if (registration) {
        await api<{ user: User }>("/auth/register", {
          method: "POST",
          body: {
            email,
            password,
            name: String(values.get("name")),
            role: String(values.get("role")),
          },
        });
        navigate("/login", {
          replace: true,
          state: { registered: true, email },
        });
      } else {
        const result = await api<LoginResponse>("/auth/login", {
          method: "POST",
          body: { email, password },
        });
        login(result.accessToken);
        navigate("/dashboard", { replace: true });
      }
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "Щось пішло не так. Спробуйте ще раз.",
      );
      if (cause instanceof ApiError) setFields(cause.fields ?? {});
    } finally {
      setBusy(false);
    }
  }
  function fieldError(name: string) {
    return fields[name] ? (
      <span className="field-error" id={`${name}-error`}>
        {fields[name]}
      </span>
    ) : null;
  }

  return (
    <div className="auth-layout">
      <section className="welcome-panel" aria-labelledby="welcome-title">
        <span className="eyebrow">
          <span className="status-dot" /> ПРОСТІШЕ РАЗОМ
        </span>
        <h1 id="welcome-title">
          Менше турбот.
          <br />
          <span>Більше дому.</span>
        </h1>
        <p className="welcome-copy">
          Ваш простір для домашніх справ
          <br className="desktop-break" /> і професійної допомоги.
        </p>
        <div className="home-illustration" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="house-card">
            <svg viewBox="0 0 160 160" fill="none">
              <path d="M27 77 80 33l53 44v60H27V77Z" fill="#234b3a" />
              <path
                d="m17 80 63-53 63 53"
                stroke="#234b3a"
                strokeWidth="11"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M65 137V96h30v41" fill="#e7ecb0" />
              <path d="M42 85h14v17H42zm64 0h14v17h-14z" fill="#f6f7e8" />
              <path d="M108 41V28h15v27" stroke="#234b3a" strokeWidth="8" />
              <path
                d="M61 48c6-8 16-13 24-14"
                stroke="#fff"
                strokeOpacity=".35"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <span className="floating-note note-check">
            ✓ <span>Починається з довіри</span>
          </span>
          <span className="floating-note note-spark">✳</span>
        </div>
        <div className="welcome-bottom">
          <span className="tiny-line" /> Свої люди. Зрозумілі рішення.
        </div>
      </section>
      <section className="form-panel" aria-labelledby="form-title">
        <div className="form-heading">
          <span className="form-step">ВАШ FIXIT</span>
          <h2 id="form-title">
            {registration ? "Будьмо знайомі" : "Раді бачити знову"}
            <span className="heading-dot">.</span>
          </h2>
          <p>
            {registration
              ? "Кілька деталей — і почнемо."
              : "Увійдіть, щоб відкрити свій простір."}
          </p>
        </div>
        {!registration && location.state?.registered && (
          <div className="notice success" role="status">
            Акаунт створено. Тепер увійдіть зі своїм паролем.
          </div>
        )}
        {!registration && location.state?.expired && (
          <div className="notice" role="status">
            Сесія завершилася. Увійдіть ще раз.
          </div>
        )}
        <form
          key={mode}
          onSubmit={submit}
          aria-label={registration ? "Реєстрація" : "Вхід"}
        >
          {registration && (
            <>
              <label htmlFor="name">Ім’я</label>
              <input
                id="name"
                name="name"
                autoComplete="name"
                placeholder="Як до вас звертатися?"
                required
                minLength={2}
                maxLength={100}
                aria-invalid={!!fields.name}
                aria-describedby={fields.name ? "name-error" : undefined}
              />
              {fieldError("name")}
            </>
          )}
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            defaultValue={!registration ? (location.state?.email ?? "") : ""}
            required
            maxLength={254}
            aria-invalid={!!fields.email}
            aria-describedby={fields.email ? "email-error" : undefined}
          />
          {fieldError("email")}
          <label htmlFor="password">Пароль</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={registration ? "new-password" : "current-password"}
            placeholder={registration ? "Щонайменше 12 символів" : "Ваш пароль"}
            required
            minLength={registration ? 12 : 1}
            maxLength={128}
            aria-invalid={!!fields.password}
            aria-describedby={
              registration
                ? "password-hint"
                : fields.password
                  ? "password-error"
                  : undefined
            }
          />
          {fieldError("password")}
          {registration && (
            <>
              <small id="password-hint">
                Від 12 до 128 символів. Можна використати фразу.
              </small>
              <fieldset className="role-picker">
                <legend>Я приєднуюсь як</legend>
                <label>
                  <input
                    type="radio"
                    name="role"
                    value="CLIENT"
                    defaultChecked
                  />
                  <span>
                    <strong>Клієнт</strong>
                    <small>Шукаю допомогу</small>
                  </span>
                </label>
                <label>
                  <input type="radio" name="role" value="MASTER" />
                  <span>
                    <strong>Майстер</strong>
                    <small>Пропоную свої вміння</small>
                  </span>
                </label>
              </fieldset>
              {fieldError("role")}
            </>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "Зачекайте…" : registration ? "Створити акаунт" : "Увійти"}
            <ArrowIcon />
          </button>
        </form>
        <p className="form-switch">
          {registration ? "Уже маєте акаунт?" : "Ще не з нами?"}{" "}
          <Link
            to={registration ? "/login" : "/register"}
            onClick={() => {
              setError("");
              setFields({});
            }}
          >
            {registration ? "Увійти" : "Створити акаунт"}
          </Link>
        </p>
        <p className="privacy-note">
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
            <rect
              x="4"
              y="7"
              width="8"
              height="6"
              rx="1"
              stroke="currentColor"
            />
            <path d="M6 7V5a2 2 0 0 1 4 0v2" stroke="currentColor" />
          </svg>{" "}
          Безпечний вхід до вашого простору.
        </p>
      </section>
    </div>
  );
}

function Dashboard() {
  const { token, logout } = useAuth();
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api<{ user: User }>("/users/me", {
      token: token!,
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setUser(data.user);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) {
          logout(true);
        } else
          setError(
            cause instanceof Error
              ? cause.message
              : "Не вдалося завантажити профіль.",
          );
      });
    return () => controller.abort();
  }, [token, logout, attempt]);
  return (
    <section className="dashboard">
      <div className="dashboard-intro">
        <span className="eyebrow">
          <span className="status-dot" /> МІЙ ПРОСТІР
        </span>
        <h1>
          Ви вдома<span className="heading-dot">.</span>
        </h1>
        <p>Ваш акаунт FixIT. Усе починається з вас.</p>
      </div>
      {error ? (
        <div className="profile-card">
          <p className="notice error" role="alert">
            {error}
          </p>
          <button
            className="secondary-button"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Спробувати ще раз
          </button>
        </div>
      ) : !user ? (
        <p role="status">Завантажуємо ваш профіль…</p>
      ) : (
        <div className="profile-card">
          <div className="profile-header">
            <span className="avatar" aria-hidden="true">
              {user.name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <span className="profile-label">ОСОБИСТИЙ ПРОФІЛЬ</span>
              <h2>{user.name}</h2>
            </div>
            <span className="role-badge">{roles[user.role]}</span>
          </div>
          <dl>
            <div>
              <dt>Email</dt>
              <dd>{user.email}</dd>
            </div>
            <div>
              <dt>Ім’я</dt>
              <dd>{user.name}</dd>
            </div>
            <div>
              <dt>Роль</dt>
              <dd>
                {roles[user.role]}{" "}
                <span className="role-code">{user.role}</span>
              </dd>
            </div>
          </dl>
          <div className="profile-footer">
            <span>
              <span className="status-dot" /> Ви увійшли у свій акаунт
            </span>
            <button className="secondary-button" onClick={() => logout()}>
              Вийти <ArrowIcon />
            </button>
          </div>
        </div>
      )}
      <p className="dashboard-note">
        Ваш простір готовий. Інші можливості FixIT з’являться згодом.
      </p>
    </section>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/dashboard" element={<Dashboard />} />
        </Route>
        <Route
          path="*"
          element={
            <section className="not-found">
              <h1>Сторінку не знайдено</h1>
              <Link to="/dashboard">
                До свого простору <ArrowIcon />
              </Link>
            </section>
          }
        />
      </Route>
    </Routes>
  );
}
