import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { bindApiSession, type User } from "./api";
import { SessionClient, type SessionSnapshot } from "./session";

interface AuthContextValue extends SessionSnapshot {
  login: (value: string, user?: User | null) => void;
  signIn: SessionClient["signIn"];
  logout: (expired?: boolean) => Promise<void>;
  retrySession: () => void;
}
const AuthContext = createContext<AuthContextValue | null>(null);

// recoverSession=false isolates pre-existing UI fixtures; main.tsx always uses live recovery.
export function AuthProvider({ children, recoverSession = true }: { children: ReactNode; recoverSession?: boolean }) {
  const [client] = useState(() => new SessionClient(recoverSession));
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  useEffect(() => {
    client.attach(); const unbind = bindApiSession(client); client.bootstrap();
    return () => { unbind(); client.detach(); };
  }, [client]);
  return <AuthContext.Provider value={{ ...state, login: client.login, signIn: client.signIn,
    logout: client.logout, retrySession: client.bootstrap }}>{children}</AuthContext.Provider>;
}
export function SessionRecovery() {
  const { status, error, retrySession } = useAuth();
  return <section className="profile-card" aria-label="Відновлення сесії">
    {status === "bootstrapping" ? <p role="status">Перевіряємо вашу сесію…</p> : <>
      <p className="notice error" role="alert">{error || "Не вдалося перевірити сесію."}</p>
      <button className="secondary-button" onClick={retrySession}>Повторити перевірку сесії</button>
    </>}
  </section>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider is required.");
  return value;
}
