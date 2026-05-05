import { useState } from "react";
import type { AnalysisEvidence } from "../../lib/api";

interface EvidenceChipProps {
  evidence: AnalysisEvidence;
}

/**
 * Inline-expanding citation. Collapsed: a small "Evidence" link.
 * Expanded: a bordered card showing the timestamped trace excerpt that
 * grounds the LLM's claim. This is the citation that turns LLM hallucination
 * from a trust-killer into a verifiable insight (architecture spec §4.2).
 */
export function EvidenceChip({ evidence }: EvidenceChipProps) {
  const [open, setOpen] = useState(false);
  const shortSession = evidence.sessionId.slice(0, 8);

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-knowable-orange hover:text-knowable-orange-hover transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`}
          viewBox="0 0 12 12"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M4 2 L8 6 L4 10 Z" />
        </svg>
        {open ? "Hide evidence" : "Evidence"}
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-knowable-border bg-knowable-cream/60 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-wider text-knowable-muted mb-1.5">
            <span className="font-mono">Session {shortSession}</span>
            <span className="font-mono">{evidence.ts}</span>
          </div>
          <p className="text-sm text-knowable-primary leading-snug">
            <span className="text-knowable-muted">"</span>
            {evidence.excerpt}
            <span className="text-knowable-muted">"</span>
          </p>
        </div>
      )}
    </div>
  );
}
