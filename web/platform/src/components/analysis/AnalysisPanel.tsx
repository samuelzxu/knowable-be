import { useCallback, useEffect, useState } from "react";
import {
  analyze,
  ApiError,
  type AnalysisEvidence,
  type AnalysisResponse,
} from "../../lib/api";
import { EvidenceChip } from "./EvidenceChip";

interface AnalysisPanelProps {
  open: boolean;
  onClose: () => void;
  classId: string;
  studentUserId: string;
  studentDisplayName: string;
}

type ErrorKind =
  | { kind: "budget" }
  | { kind: "not_sharing" }
  | { kind: "unavailable" }
  | { kind: "generic"; message: string };

function classifyError(err: unknown): ErrorKind {
  if (err instanceof ApiError) {
    if (err.status === 429) return { kind: "budget" };
    if (err.status === 404) return { kind: "not_sharing" };
    if (err.status === 502) return { kind: "unavailable" };
    return { kind: "generic", message: `Request failed (${err.status}).` };
  }
  return {
    kind: "generic",
    message: err instanceof Error ? err.message : "Something went wrong.",
  };
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}

function evidenceForClaim(
  claim: string,
  evidence: AnalysisEvidence[]
): AnalysisEvidence | null {
  const claimNorm = claim.toLowerCase();
  // Prefer exact substring match — if the LLM wrote a tight evidence claim
  // it'll be a substring or near-substring of the displayed claim.
  const direct = evidence.find(
    (e) =>
      claimNorm.includes(e.claim.toLowerCase()) ||
      e.claim.toLowerCase().includes(claimNorm)
  );
  if (direct) return direct;
  // Fallback: first evidence row that shares ≥3 word stems.
  const claimWords = new Set(
    claimNorm.split(/[^a-z0-9]+/).filter((w) => w.length >= 4)
  );
  let best: { ev: AnalysisEvidence; score: number } | null = null;
  for (const e of evidence) {
    const words = new Set(
      e.claim
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4)
    );
    let score = 0;
    for (const w of words) if (claimWords.has(w)) score++;
    if (score >= 2 && (!best || score > best.score)) {
      best = { ev: e, score };
    }
  }
  return best?.ev ?? null;
}

interface SectionProps {
  title: string;
  tone: "strength" | "struggle" | "pattern" | "recommendation";
  items: string[];
  evidence: AnalysisEvidence[];
}

function toneClasses(tone: SectionProps["tone"]) {
  switch (tone) {
    case "strength":
      return {
        dot: "bg-emerald-500",
        ring: "ring-emerald-200",
      };
    case "struggle":
      return {
        dot: "bg-knowable-orange",
        ring: "ring-knowable-orange/30",
      };
    case "pattern":
      return {
        dot: "bg-amber-500",
        ring: "ring-amber-200",
      };
    case "recommendation":
      return {
        dot: "bg-sky-500",
        ring: "ring-sky-200",
      };
  }
}

function Section({ title, tone, items, evidence }: SectionProps) {
  const { dot } = toneClasses(tone);
  if (items.length === 0) return null;
  return (
    <section className="mb-8">
      <div className="flex items-center gap-2.5 mb-3">
        <span className={`w-2.5 h-2.5 rounded-full ${dot}`} aria-hidden="true" />
        <h3 className="font-serif text-xl text-knowable-primary">{title}</h3>
      </div>
      <ul className="space-y-3">
        {items.map((claim, i) => {
          const ev = evidenceForClaim(claim, evidence);
          return (
            <li
              key={i}
              className="rounded-xl border border-knowable-border bg-knowable-card px-4 py-3"
            >
              <p className="text-sm text-knowable-primary leading-relaxed">
                {claim}
              </p>
              {ev && <EvidenceChip evidence={ev} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SkeletonSection({ count = 2 }: { count?: number }) {
  return (
    <section className="mb-8">
      <div className="flex items-center gap-2.5 mb-3">
        <span className="w-2.5 h-2.5 rounded-full bg-knowable-border" />
        <div className="h-5 w-36 rounded bg-knowable-border/60 animate-pulse" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-knowable-border bg-knowable-card px-4 py-3"
          >
            <div className="space-y-2">
              <div className="h-3.5 w-full rounded bg-knowable-border/60 animate-pulse" />
              <div
                className="h-3.5 w-4/5 rounded bg-knowable-border/60 animate-pulse"
                style={{ animationDelay: "120ms" }}
              />
            </div>
            <div className="mt-3 h-3 w-20 rounded bg-knowable-border/40 animate-pulse" />
          </div>
        ))}
      </div>
    </section>
  );
}

export function AnalysisPanel({
  open,
  onClose,
  classId,
  studentUserId,
  studentDisplayName,
}: AnalysisPanelProps) {
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ErrorKind | null>(null);

  const runAnalysis = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await analyze(studentUserId, classId, 7);
      setAnalysis(result);
      // Trust the server's `generatedAt` — survives the 24h cache so a
      // cached response renders the original generation time, not "now".
      setGeneratedAt(result.generatedAt ?? new Date().toISOString());
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setLoading(false);
    }
  }, [studentUserId, classId]);

  useEffect(() => {
    if (open) {
      // Trigger analysis on open if we don't already have one.
      if (!analysis && !loading) {
        void runAnalysis();
      }
    }
  }, [open, analysis, loading, runAnalysis]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Reset state when the target student changes.
  useEffect(() => {
    setAnalysis(null);
    setGeneratedAt(null);
    setError(null);
  }, [studentUserId]);

  const showSkeleton = loading && !analysis;

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden={!open}
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/30 backdrop-blur-sm transition-opacity ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />
      {/* Slide-over panel */}
      <aside
        role="dialog"
        aria-label={`Analysis for ${studentDisplayName}`}
        className={`fixed top-0 right-0 z-50 h-full w-full sm:w-[540px] bg-knowable-cream border-l border-knowable-border shadow-2xl transform transition-transform duration-300 ease-out flex flex-col ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="flex items-start justify-between gap-4 px-7 py-6 border-b border-knowable-border">
          <div>
            <p className="text-xs uppercase tracking-widest text-knowable-muted mb-1">
              AI insights
            </p>
            <h2 className="font-serif text-2xl text-knowable-primary leading-snug">
              {studentDisplayName}
            </h2>
            <div className="mt-2 flex items-center gap-3 text-sm">
              {generatedAt ? (
                <>
                  <span className="text-knowable-muted">
                    Generated {formatRelativeTime(generatedAt)}
                  </span>
                  <button
                    type="button"
                    onClick={runAnalysis}
                    disabled={loading}
                    className="text-knowable-orange hover:text-knowable-orange-hover font-medium disabled:opacity-60"
                  >
                    {loading ? "Refreshing…" : "Refresh"}
                  </button>
                </>
              ) : loading ? (
                <span className="text-knowable-muted italic">
                  Asking Bedrock-Opus to analyze recent sessions…
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="text-knowable-muted hover:text-knowable-primary transition-colors text-2xl leading-none"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-7 py-6">
          {error ? (
            <ErrorState kind={error} onRetry={runAnalysis} />
          ) : showSkeleton ? (
            <>
              <SkeletonSection count={2} />
              <SkeletonSection count={2} />
              <SkeletonSection count={2} />
              <SkeletonSection count={3} />
            </>
          ) : analysis ? (
            <>
              <Section
                title="Strengths"
                tone="strength"
                items={analysis.strengths}
                evidence={analysis.evidence}
              />
              <Section
                title="Struggles"
                tone="struggle"
                items={analysis.struggles}
                evidence={analysis.evidence}
              />
              <Section
                title="Patterns"
                tone="pattern"
                items={analysis.patterns}
                evidence={analysis.evidence}
              />
              <Section
                title="Recommendations"
                tone="recommendation"
                items={analysis.recommendations}
                evidence={analysis.evidence}
              />
              <p className="mt-8 text-xs text-knowable-muted leading-relaxed">
                Generated by Claude Opus from this student's session traces.
                Every claim above is grounded in the evidence chips — click to
                see the timestamped excerpt. Cached for 24 hours.
              </p>
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}

function ErrorState({
  kind,
  onRetry,
}: {
  kind: ErrorKind;
  onRetry: () => void;
}) {
  let title = "Analysis temporarily unavailable.";
  let body = "Try again in a moment.";
  let canRetry = true;
  if (kind.kind === "budget") {
    title = "Daily AI analysis budget reached for this class.";
    body = "Try again tomorrow.";
    canRetry = false;
  } else if (kind.kind === "not_sharing") {
    title = "This student hasn't enabled activity sharing.";
    body =
      "They can enable it in the Knowable app under Settings → Your Class.";
    canRetry = false;
  } else if (kind.kind === "unavailable") {
    title = "Analysis temporarily unavailable.";
    body = "The model didn't return a usable response. Try again.";
  } else if (kind.kind === "generic") {
    body = kind.message;
  }
  return (
    <div className="rounded-2xl border border-knowable-border bg-knowable-card px-6 py-8 text-center">
      <h3 className="font-serif text-xl text-knowable-primary mb-2">{title}</h3>
      <p className="text-sm text-knowable-muted mb-5">{body}</p>
      {canRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-xl bg-knowable-orange hover:bg-knowable-orange-hover px-4 py-2 text-sm font-semibold text-white transition-colors"
        >
          Try again
        </button>
      )}
    </div>
  );
}
