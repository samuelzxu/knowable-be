import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClass, ApiError, type Class } from "../lib/api";
import { JoinCodeDisplay } from "./JoinCodeDisplay";

interface CreateClassModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (cls: Class) => void;
}

export function CreateClassModal({
  open,
  onClose,
  onCreated,
}: CreateClassModalProps) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Class | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      // Reset on open.
      setName("");
      setError(null);
      setCreated(null);
      setSubmitting(false);
      // Focus after the modal renders.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const cls = await createClass(trimmed);
      setCreated(cls);
      onCreated(cls);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `Couldn't create class (${err.status}).`
          : "Couldn't create class. Please try again.";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8 bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-lg rounded-2xl border border-knowable-border bg-knowable-card shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-knowable-muted hover:text-knowable-primary transition-colors text-2xl leading-none"
        >
          ×
        </button>

        {created ? (
          <div className="p-8">
            <p className="text-sm text-knowable-muted mb-4">
              Class created. Share this code with your students:
            </p>
            <JoinCodeDisplay className={created.name} code={created.code} />
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl bg-knowable-orange hover:bg-knowable-orange-hover px-5 py-2.5 text-sm font-semibold text-white transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-8">
            <h2 className="font-serif text-2xl text-knowable-primary mb-2">
              New class
            </h2>
            <p className="text-sm text-knowable-muted mb-6">
              Give your class a name students will recognize. We'll generate a
              join code on the next screen.
            </p>
            <label
              htmlFor="class-name"
              className="block text-sm font-medium text-knowable-primary mb-1.5"
            >
              Class name
            </label>
            <input
              ref={inputRef}
              id="class-name"
              type="text"
              required
              maxLength={120}
              placeholder="e.g. AP Calculus — Period 3"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              className="w-full rounded-lg border border-knowable-border bg-white px-4 py-2.5 text-knowable-primary placeholder-knowable-muted focus:outline-none focus:ring-2 focus:ring-knowable-orange focus:border-transparent transition"
            />
            {error && (
              <p
                className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                role="alert"
              >
                {error}
              </p>
            )}
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-knowable-border bg-white hover:bg-knowable-cream px-4 py-2.5 text-sm font-medium text-knowable-primary transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !name.trim()}
                className="rounded-xl bg-knowable-orange hover:bg-knowable-orange-hover disabled:opacity-60 disabled:cursor-not-allowed px-5 py-2.5 text-sm font-semibold text-white transition-colors"
              >
                {submitting ? "Creating…" : "Create class"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
