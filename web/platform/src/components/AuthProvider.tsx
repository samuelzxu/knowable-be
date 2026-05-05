import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  confirmSignUp as cognitoConfirmSignUp,
  getCurrentSession,
  signIn as cognitoSignIn,
  signOut as cognitoSignOut,
  signUp as cognitoSignUp,
  type Session,
} from "../lib/cognito";

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<Session>;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  confirmSignUp: (email: string, code: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getCurrentSession()
      .then((s) => {
        if (!cancelled) {
          setSession(s);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSession(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignIn = useCallback(
    async (email: string, password: string) => {
      const s = await cognitoSignIn(email, password);
      setSession(s);
      return s;
    },
    []
  );

  const handleSignUp = useCallback(
    async (email: string, password: string, displayName: string) => {
      await cognitoSignUp(email, password, displayName);
    },
    []
  );

  const handleConfirm = useCallback(
    async (email: string, code: string) => {
      await cognitoConfirmSignUp(email, code);
    },
    []
  );

  const handleSignOut = useCallback(() => {
    cognitoSignOut();
    setSession(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      loading,
      signIn: handleSignIn,
      signUp: handleSignUp,
      confirmSignUp: handleConfirm,
      signOut: handleSignOut,
    }),
    [session, loading, handleSignIn, handleSignUp, handleConfirm, handleSignOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}
