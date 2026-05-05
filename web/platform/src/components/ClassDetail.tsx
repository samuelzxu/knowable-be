import { useCallback, useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./AuthProvider";
import { JoinCodeDisplay } from "./JoinCodeDisplay";
import { AnalysisPanel } from "./analysis/AnalysisPanel";
import {
  getDashboard,
  ApiError,
  type DashboardMember,
  type DashboardResponse,
  type SharingTier,
} from "../lib/api";

interface ClassDetailProps {
  classId: string;
}

function tierLabel(tier: SharingTier): string {
  switch (tier) {
    case "off":
      return "Off";
    case "stats":
      return "Stats";
    case "stats+activity":
      return "Stats + Activity";
  }
}

function tierBadge(tier: SharingTier): string {
  switch (tier) {
    case "off":
      return "bg-stone-200 text-stone-600";
    case "stats":
      return "bg-knowable-orange/15 text-knowable-orange";
    case "stats+activity":
      return "bg-knowable-orange/25 text-knowable-orange-hover";
  }
}

function fmtMinutes(min: number | null | undefined): string {
  if (!min || !Number.isFinite(min)) return "—";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function fmtSolveTime(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function fmtHints(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (n < 1) return n.toFixed(2);
  return n.toFixed(1);
}

interface RowProps {
  member: DashboardMember;
  onAnalyze: (m: DashboardMember) => void;
}

function Row({ member, onAnalyze }: RowProps) {
  const isOff = member.sharingTier === "off";
  const canAnalyze = member.sharingTier === "stats+activity";
  const insights = member.insights;

  return (
    <tr className="border-t border-knowable-border hover:bg-knowable-card/60 transition-colors">
      <td className="py-3.5 px-4">
        <div className="font-medium text-knowable-primary">
          {member.displayName || "—"}
        </div>
        <div className="text-xs text-knowable-muted font-mono mt-0.5">
          {member.studentUserId.slice(0, 8)}
        </div>
      </td>
      <td className="py-3.5 px-4">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${tierBadge(
            member.sharingTier
          )}`}
        >
          {tierLabel(member.sharingTier)}
        </span>
        {isOff && (
          <div className="text-xs text-knowable-muted mt-1">
            Not sharing yet
          </div>
        )}
      </td>
      <td className="py-3.5 px-4 text-knowable-primary">
        {isOff ? "—" : insights?.sessionsThisWeek ?? "—"}
      </td>
      <td className="py-3.5 px-4 text-knowable-primary">
        {isOff ? "—" : fmtMinutes(insights?.totalMinutes)}
      </td>
      <td className="py-3.5 px-4 text-knowable-primary">
        {isOff ? "—" : fmtHints(insights?.hintsPerSession)}
      </td>
      <td className="py-3.5 px-4 text-knowable-primary">
        {isOff ? "—" : fmtSolveTime(insights?.avgSolveTimeMs)}
      </td>
      <td className="py-3.5 px-4 text-right">
        {canAnalyze ? (
          <button
            type="button"
            onClick={() => onAnalyze(member)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-knowable-orange hover:bg-knowable-orange-hover px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-knowable-orange/20 transition-colors"
          >
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M8 1l1.8 4.6L14.5 7l-4.7 1.4L8 13l-1.8-4.6L1.5 7l4.7-1.4L8 1z" />
            </svg>
            Insights
          </button>
        ) : (
          <button
            type="button"
            disabled
            title={
              member.sharingTier === "stats"
                ? "Activity sharing not enabled for this student."
                : "Student is not sharing yet."
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-stone-100 text-stone-400 px-3 py-1.5 text-xs font-medium cursor-not-allowed"
          >
            Insights
          </button>
        )}
      </td>
    </tr>
  );
}

function ClassDetailInner({ classId }: ClassDetailProps) {
  const { session, loading, signOut } = useAuth();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const [analyzeTarget, setAnalyzeTarget] = useState<DashboardMember | null>(
    null
  );
  const [panelOpen, setPanelOpen] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const result = await getDashboard(classId);
      setData(result);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setError(
        err instanceof ApiError
          ? err.status === 404
            ? "Class not found."
            : err.status === 403
              ? "You don't have access to this class."
              : `Couldn't load class (${err.status}).`
          : "Couldn't load class."
      );
    }
  }, [classId]);

  useEffect(() => {
    if (!loading && !session && !redirecting) {
      setRedirecting(true);
      window.location.href = "/";
    }
  }, [loading, session, redirecting]);

  useEffect(() => {
    if (session) void refresh();
  }, [session, refresh]);

  if (loading || (!session && !redirecting)) {
    return (
      <div className="text-knowable-muted text-center py-24">Loading…</div>
    );
  }
  if (!session) return null;

  return (
    <div className="w-full max-w-6xl mx-auto px-6 py-10">
      <nav className="flex items-center justify-between mb-6 text-sm">
        <a
          href="/dashboard"
          className="text-knowable-muted hover:text-knowable-primary transition-colors inline-flex items-center gap-1"
        >
          <span aria-hidden="true">←</span> All classes
        </a>
        <button
          type="button"
          onClick={() => {
            signOut();
            window.location.href = "/";
          }}
          className="text-knowable-muted hover:text-knowable-primary transition-colors"
        >
          Sign out
        </button>
      </nav>

      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-6 py-8 text-center">
          <p className="text-red-700">{error}</p>
        </div>
      ) : data === null ? (
        <div className="space-y-6">
          <div className="h-24 rounded-2xl border border-knowable-border bg-knowable-card animate-pulse" />
          <div className="h-96 rounded-2xl border border-knowable-border bg-knowable-card animate-pulse" />
        </div>
      ) : (
        <>
          <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-8">
            <div>
              <p className="text-xs uppercase tracking-widest text-knowable-muted mb-2">
                Class
              </p>
              <h1 className="font-serif text-4xl text-knowable-primary">
                {data.class.name}
              </h1>
              <p className="mt-2 text-sm text-knowable-muted">
                {data.members.length}{" "}
                {data.members.length === 1 ? "student" : "students"} ·
                {" "}
                {
                  data.members.filter((m) => m.sharingTier !== "off").length
                }{" "}
                sharing
              </p>
            </div>
            <JoinCodeDisplay
              className={data.class.name}
              code={data.class.code}
              size="header"
            />
          </header>

          <section className="rounded-2xl border border-knowable-border bg-knowable-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-knowable-cream/60">
                  <tr className="text-left text-xs uppercase tracking-wider text-knowable-muted">
                    <th className="py-3 px-4 font-medium">Student</th>
                    <th className="py-3 px-4 font-medium">Sharing</th>
                    <th className="py-3 px-4 font-medium">Sessions (wk)</th>
                    <th className="py-3 px-4 font-medium">Total time</th>
                    <th className="py-3 px-4 font-medium">Hints / session</th>
                    <th className="py-3 px-4 font-medium">Avg solve</th>
                    <th className="py-3 px-4 font-medium text-right">
                      Insights
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="py-12 text-center text-knowable-muted"
                      >
                        No students have joined yet. Share your class code so
                        students can join.
                      </td>
                    </tr>
                  ) : (
                    data.members.map((m) => (
                      <Row
                        key={m.studentUserId}
                        member={m}
                        onAnalyze={(target) => {
                          setAnalyzeTarget(target);
                          setPanelOpen(true);
                        }}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <p className="mt-6 text-xs text-knowable-muted leading-relaxed max-w-2xl">
            Numeric insights cover the last 7 days of activity. AI insights are
            available only for students who have opted into{" "}
            <span className="text-knowable-primary">Stats + Activity</span>{" "}
            sharing — Knowable never sees notebook contents.
          </p>
        </>
      )}

      {analyzeTarget && (
        <AnalysisPanel
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          classId={classId}
          studentUserId={analyzeTarget.studentUserId}
          studentDisplayName={analyzeTarget.displayName}
        />
      )}
    </div>
  );
}

export function ClassDetail({ classId }: ClassDetailProps) {
  return (
    <AuthProvider>
      <ClassDetailInner classId={classId} />
    </AuthProvider>
  );
}
