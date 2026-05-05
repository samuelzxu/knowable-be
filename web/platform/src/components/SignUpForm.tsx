import { useState, type FormEvent } from "react";
import { AuthProvider, useAuth } from "./AuthProvider";
import { BrandLogo } from "./BrandLogo";
import { isCognitoConfigured } from "../lib/cognito";

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL;

type Stage = "details" | "confirm";

interface PasswordRule {
  id: string;
  label: string;
  test: (pw: string) => boolean;
}

const passwordRules: PasswordRule[] = [
  { id: "len", label: "At least 12 characters", test: (p) => p.length >= 12 },
  { id: "lower", label: "Lowercase letter", test: (p) => /[a-z]/.test(p) },
  { id: "upper", label: "Uppercase letter", test: (p) => /[A-Z]/.test(p) },
  { id: "number", label: "Number", test: (p) => /[0-9]/.test(p) },
  { id: "symbol", label: "Symbol", test: (p) => /[^a-zA-Z0-9]/.test(p) },
];

function SignUpFormInner() {
  const { signUp, confirmSignUp, signIn } = useAuth();
  const [stage, setStage] = useState<Stage>("details");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmitDetails(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!email || !password || !displayName) {
      setError("Please fill in every field.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    const unmet = passwordRules.find((r) => !r.test(password));
    if (unmet) {
      setError(`Password must include: ${unmet.label.toLowerCase()}.`);
      return;
    }

    setSubmitting(true);
    try {
      await signUp(email.trim(), password, displayName.trim());
      setStage("confirm");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Signup failed. Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmitConfirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const trimmed = code.trim();
    if (trimmed.length < 6) return;

    setSubmitting(true);
    try {
      await confirmSignUp(email.trim(), trimmed);
      // Auto sign-in with the credentials we already have in state.
      const session = await signIn(email.trim(), password);
      // Register as educator with the JWT we just got.
      await registerEducator(session.idToken, displayName.trim());
      window.location.href = "/dashboard";
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Confirmation failed. Please try again."
      );
      setSubmitting(false);
    }
  }

  if (stage === "details") {
    return (
      <form
        onSubmit={handleSubmitDetails}
        className="flex flex-col gap-4"
        noValidate
      >
        <div>
          <label htmlFor="displayName" className="field-label">
            Your name
          </label>
          <input
            id="displayName"
            name="displayName"
            type="text"
            required
            autoComplete="name"
            placeholder="Ms. Smith"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={submitting}
            className="field-input"
          />
        </div>

        <div>
          <label htmlFor="email" className="field-label">
            School email
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
            autoComplete="new-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            className="field-input"
          />
          {password.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {passwordRules.map((rule) => {
                const met = rule.test(password);
                return (
                  <li
                    key={rule.id}
                    className={
                      met
                        ? "text-sage-600 dark:text-sage-400"
                        : "text-warm-500 dark:text-warm-400"
                    }
                  >
                    {met ? "✓" : "○"} {rule.label}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <label htmlFor="confirmPassword" className="field-label">
            Confirm password
          </label>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            required
            autoComplete="new-password"
            placeholder="••••••••"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
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
          disabled={submitting}
          className="btn-primary w-full mt-2"
        >
          {submitting ? "Creating account…" : "Create account"}
        </button>

        <p className="text-sm text-warm-500 dark:text-warm-400 text-center mt-2">
          Already have an account?{" "}
          <a
            href="/"
            className="text-milo-500 hover:text-milo-600 font-semibold"
          >
            Sign in
          </a>
        </p>
      </form>
    );
  }

  return (
    <form
      onSubmit={handleSubmitConfirm}
      className="flex flex-col gap-4"
      noValidate
    >
      <div className="text-center">
        <p className="text-sm text-warm-500 dark:text-warm-400">
          We sent a 6-digit code to
        </p>
        <p className="font-semibold text-warm-900 dark:text-cream-50">
          {email}
        </p>
      </div>

      <div>
        <label htmlFor="code" className="field-label">
          Verification code
        </label>
        <input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={submitting}
          className="field-input text-center text-xl tracking-[0.4em] font-mono"
          maxLength={6}
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
        disabled={submitting || code.trim().length < 6}
        className="btn-primary w-full mt-2"
      >
        {submitting ? "Verifying…" : "Verify & continue"}
      </button>

      <button
        type="button"
        onClick={() => {
          setStage("details");
          setCode("");
          setError(null);
        }}
        className="text-sm text-warm-500 hover:text-warm-700 dark:text-warm-400"
      >
        ← Back
      </button>
    </form>
  );
}

async function registerEducator(idToken: string, displayName: string): Promise<void> {
  if (!API_BASE_URL) {
    throw new Error(
      "PUBLIC_API_BASE_URL is not configured — cannot register educator."
    );
  }
  const res = await fetch(`${API_BASE_URL}/educator/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) {
    let message = `Educator registration failed (${res.status}).`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.error ?? body.message ?? message;
    } catch {
      // body wasn't json; keep generic message
    }
    throw new Error(message);
  }
}

export function SignUpForm() {
  if (!isCognitoConfigured) {
    return <ConfigMissingNotice />;
  }
  return (
    <AuthProvider>
      <div className="auth-card p-8 sm:p-10 w-full max-w-md">
        <BrandLogo subtitle="Create your educator account" />
        <SignUpFormInner />
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
