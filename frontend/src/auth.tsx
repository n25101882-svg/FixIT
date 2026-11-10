import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

interface AuthContextValue {
  token: string | null;
  sessionExpired: boolean;
  login: (value: string) => void;
  logout: (expired?: boolean) => void;
}
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Short-lived access token in memory only: no localStorage/sessionStorage.
  const [token, setToken] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const login = useCallback((value: string) => {
    setSessionExpired(false);
    setToken(value);
  }, []);
  const logout = useCallback((expired = false) => {
    setSessionExpired(expired);
    setToken(null);
  }, []);
  return (
    <AuthContext.Provider value={{ token, sessionExpired, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider is required.");
  return value;
}
