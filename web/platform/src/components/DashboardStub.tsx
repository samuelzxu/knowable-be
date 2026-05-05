import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./AuthProvider";
import { BrandLogo } from "./BrandLogo";

function DashboardStubInner() {
  const { session, loading, signOut } = useAuth();
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    if (!loading && !session && !redirecting) {
      setRedirecting(true);
      window.location.href = "/";
    }
  }, [loading, session, redirecting]);

  if (loading) {
    return (
      <div className="auth-card p-10 w-full max-w-md text-center">
        <p className="text-warm-500 dark:text-warm-400">Loading…</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="auth-card p-10 w-full max-w-md text-center">
        <p className="text-warm-500 dark:text-warm-400">Redirecting to sign in…</p>
      </div>
    );
  }

  return (
    <div className="auth-card p-10 w-full max-w-2xl">
      <BrandLogo subtitle="Educator dashboard" />
      <div className="text-center space-y-4">
        <h2 className="font-display text-3xl text-warm-900 dark:text-cream-50">
          Welcome{session.email ? `, ${session.email}` : ""}.
        </h2>
        <p className="text-warm-500 dark:text-warm-400">
          Class management is coming soon. You'll be able to create classes,
          share join codes, and view how your students are learning — without
          ever seeing their notebook.
        </p>
        <div className="pt-4">
          <button
            type="button"
            onClick={() => {
              signOut();
              window.location.href = "/";
            }}
            className="btn-secondary"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

export function DashboardStub() {
  return (
    <AuthProvider>
      <DashboardStubInner />
    </AuthProvider>
  );
}
