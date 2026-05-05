import { useState, type FormEvent } from "react";
import { AuthProvider, useAuth } from "./AuthProvider";
import { BrandLogo } from "./BrandLogo";
import { isCognitoConfigured } from "../lib/cognito";

function SignInFormInner() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email || !password) return;
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      window.location.href = "/dashboard";
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Sign in failed. Please try again.";
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <div>
        <label htmlFor="email" className="field-label">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@school.edu"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          className="field-input"
        />
      </div>

      <div>
        <label htmlFor="password" className="field-label">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
          className="field-input"
        />
      </div>

      {error && (
        <p
          className="text-sm text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2"
          role="alert"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || !email || !password}
        className="btn-primary w-full mt-2"
      >
        {submitting ? "Signing in…" : "Sign In"}
      </button>

      <p className="text-sm text-warm-500 dark:text-warm-400 text-center mt-2">
        New here?{" "}
        <a
          href="/signup"
          className="text-milo-500 hover:text-milo-600 font-semibold"
        >
          Create an educator account
        </a>
      </p>
    </form>
  );
}

export function SignInForm() {
  if (!isCognitoConfigured) {
    return <ConfigMissingNotice />;
  }
  return (
    <AuthProvider>
      <div className="auth-card p-8 sm:p-10 w-full max-w-md">
        <BrandLogo subtitle="Sign in to your educator dashboard" />
        <SignInFormInner />
      </div>
    </AuthProvider>
  );
}

function ConfigMissingNotice() {
  return (
    <div className="auth-card p-8 sm:p-10 w-full max-w-md">
      <BrandLogo subtitle="Configuration missing" />
      <div className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-4 text-sm text-amber-800 dark:text-amber-300">
        Set <code className="font-mono">PUBLIC_COGNITO_USER_POOL_ID</code>,{" "}
        <code className="font-mono">PUBLIC_COGNITO_CLIENT_ID</code>, and{" "}
        <code className="font-mono">PUBLIC_API_BASE_URL</code> at build time
        (deploy-platform.sh injects them).
      </div>
    </div>
  );
}
