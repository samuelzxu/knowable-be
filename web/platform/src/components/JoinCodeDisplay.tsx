import { useState } from "react";

interface JoinCodeDisplayProps {
  className: string;
  code: string;
  size?: "modal" | "header";
}

/**
 * Large-format class code display. Used in:
 * - The CreateClassModal post-creation state (size="modal")
 *   where teachers project the code on a classroom screen.
 * - The class detail header (size="header") where the code is
 *   compact but always visible.
 */
export function JoinCodeDisplay({
  className,
  code,
  size = "modal",
}: JoinCodeDisplayProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Some browsers block clipboard writes without user activation;
      // silent failure is acceptable — the code is also visible on screen.
    }
  }

  const isModal = size === "modal";
  const formatted = code.split("").join(" ");

  return (
    <div
      className={
        isModal
          ? "rounded-2xl border border-knowable-border bg-knowable-card px-8 py-10 text-center"
          : "inline-flex items-center gap-3 rounded-xl border border-knowable-border bg-knowable-card px-4 py-2"
      }
    >
      {isModal && (
        <h2 className="font-serif text-3xl text-knowable-primary mb-2">
          {className}
        </h2>
      )}
      {isModal && (
        <p className="text-sm uppercase tracking-widest text-knowable-muted mb-4">
          Class code
        </p>
      )}
      <div
        className={
          isModal
            ? "font-mono font-semibold text-6xl text-knowable-primary tracking-[0.4em] mb-6 select-all"
            : "font-mono font-semibold text-xl text-knowable-primary tracking-[0.25em] select-all"
        }
        aria-label={`Class code ${code}`}
      >
        {formatted}
      </div>
      {isModal ? (
        <>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-2 rounded-lg border border-knowable-border bg-white px-4 py-2 text-sm font-medium text-knowable-primary hover:bg-knowable-cream transition-colors"
          >
            {copied ? "Copied!" : "Copy code"}
          </button>
          <p className="mt-6 text-sm text-knowable-muted">
            Students enter this code in the Knowable app's
            {" "}<span className="text-knowable-primary">Settings → Your Class</span>.
          </p>
        </>
      ) : (
        <button
          type="button"
          onClick={handleCopy}
          className="text-xs font-medium text-knowable-muted hover:text-knowable-primary transition-colors"
          aria-label="Copy class code"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}
