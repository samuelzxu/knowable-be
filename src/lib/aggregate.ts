// Pure aggregation helpers for the educator dashboard.
// See .omc/design/educator-tools/02-architecture.md §4.1.
//
// These are pure functions — no DDB calls inside — so the dashboard handler
// can call DDB once per student then plug the rows into either
// `aggregateFromSessions` (cloud-sessions student) or
// `aggregateFromLatestStats` (Privacy-Mode student who only uploads
// aggregates).

import type { SessionRecord } from "./dynamo.js";
import type { ShareStats } from "./share-schemas.js";

export interface NumericInsights {
  sessionsThisWeek: number;
  totalMinutes: number;
  hintsPerSession: number;
  avgSolveTimeMs: number;
}

const ONE_WEEK_MS = 7 * 86_400 * 1000;

/**
 * Compute the 4 numeric insights from raw `knowable-sessions` rows.
 * Time window is the last 7 days from `now` (default = current time, but
 * injectable so tests can pin it deterministically).
 */
export function aggregateFromSessions(
  rows: SessionRecord[],
  now: Date = new Date()
): NumericInsights {
  const windowStart = now.getTime() - ONE_WEEK_MS;
  let sessionsThisWeek = 0;
  let totalMs = 0;
  let totalHints = 0;
  let solveTimeSum = 0;
  let solveTimeCount = 0;

  for (const row of rows) {
    const startedMs = Date.parse(row.startedAt);
    if (Number.isNaN(startedMs) || startedMs < windowStart) continue;
    sessionsThisWeek++;

    if (row.endedAt) {
      const endedMs = Date.parse(row.endedAt);
      if (!Number.isNaN(endedMs) && endedMs > startedMs) {
        totalMs += endedMs - startedMs;
      }
    }

    totalHints += row.hintsCount ?? 0;

    if (typeof row.avgTimeToSolveMs === "number" && row.avgTimeToSolveMs > 0) {
      solveTimeSum += row.avgTimeToSolveMs;
      solveTimeCount++;
    }
  }

  const totalMinutes = Math.round(totalMs / 60_000);
  const hintsPerSession = sessionsThisWeek > 0 ? totalHints / sessionsThisWeek : 0;
  const avgSolveTimeMs = solveTimeCount > 0 ? solveTimeSum / solveTimeCount : 0;

  return { sessionsThisWeek, totalMinutes, hintsPerSession, avgSolveTimeMs };
}

/**
 * Convert a Privacy-Mode student's `latestStats` blob into the same
 * `NumericInsights` shape. Stats blobs are already aggregates over a fixed
 * period — we trust the period and just reshape the field names.
 */
export function aggregateFromLatestStats(stats: ShareStats): NumericInsights {
  const hintsPerSession =
    stats.sessionCount > 0 ? stats.totalHints / stats.sessionCount : 0;
  return {
    sessionsThisWeek: stats.sessionCount,
    totalMinutes: Math.round(stats.totalMinutes),
    hintsPerSession,
    avgSolveTimeMs: stats.avgSolveTimeMs,
  };
}
