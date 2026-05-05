import { describe, it, expect } from "vitest";
import {
  aggregateFromSessions,
  aggregateFromLatestStats,
} from "../src/lib/aggregate.js";
import type { SessionRecord } from "../src/lib/dynamo.js";

const NOW = new Date("2026-05-04T12:00:00Z");
const oneDayAgo = new Date(NOW.getTime() - 86_400 * 1000).toISOString();
const twoDaysAgo = new Date(NOW.getTime() - 2 * 86_400 * 1000).toISOString();
const tenDaysAgo = new Date(NOW.getTime() - 10 * 86_400 * 1000).toISOString();

describe("aggregateFromSessions", () => {
  it("returns zeroed insights for an empty list", () => {
    const result = aggregateFromSessions([], NOW);
    expect(result).toEqual({
      sessionsThisWeek: 0,
      totalMinutes: 0,
      hintsPerSession: 0,
      avgSolveTimeMs: 0,
    });
  });

  it("counts only sessions started in the last 7 days", () => {
    const rows: SessionRecord[] = [
      {
        userId: "u",
        sessionId: "a",
        startedAt: oneDayAgo,
        endedAt: new Date(Date.parse(oneDayAgo) + 30 * 60_000).toISOString(),
        hintsCount: 2,
        avgTimeToSolveMs: 30_000,
      },
      {
        userId: "u",
        sessionId: "b",
        startedAt: twoDaysAgo,
        endedAt: new Date(Date.parse(twoDaysAgo) + 60 * 60_000).toISOString(),
        hintsCount: 4,
        avgTimeToSolveMs: 50_000,
      },
      // 10 days ago — outside the window, excluded entirely
      {
        userId: "u",
        sessionId: "c",
        startedAt: tenDaysAgo,
        endedAt: new Date(Date.parse(tenDaysAgo) + 30 * 60_000).toISOString(),
        hintsCount: 99,
        avgTimeToSolveMs: 999_000,
      },
    ];
    const result = aggregateFromSessions(rows, NOW);
    expect(result.sessionsThisWeek).toBe(2);
    expect(result.totalMinutes).toBe(90); // 30 + 60 minutes
    expect(result.hintsPerSession).toBe(3); // (2+4)/2
    expect(result.avgSolveTimeMs).toBe(40_000); // (30k + 50k) / 2
  });

  it("ignores sessions without endedAt for totalMinutes but still counts them", () => {
    const rows: SessionRecord[] = [
      {
        userId: "u",
        sessionId: "open",
        startedAt: oneDayAgo,
        // No endedAt — duration unknown
        hintsCount: 1,
      },
    ];
    const result = aggregateFromSessions(rows, NOW);
    expect(result.sessionsThisWeek).toBe(1);
    expect(result.totalMinutes).toBe(0);
    expect(result.hintsPerSession).toBe(1);
    expect(result.avgSolveTimeMs).toBe(0);
  });

  it("treats missing hintsCount and avgTimeToSolveMs as zero/skip", () => {
    const rows: SessionRecord[] = [
      {
        userId: "u",
        sessionId: "x",
        startedAt: oneDayAgo,
        endedAt: new Date(Date.parse(oneDayAgo) + 15 * 60_000).toISOString(),
      },
    ];
    const result = aggregateFromSessions(rows, NOW);
    expect(result.sessionsThisWeek).toBe(1);
    expect(result.totalMinutes).toBe(15);
    expect(result.hintsPerSession).toBe(0);
    expect(result.avgSolveTimeMs).toBe(0);
  });
});

describe("aggregateFromLatestStats", () => {
  it("converts a stats blob into NumericInsights", () => {
    const result = aggregateFromLatestStats({
      sessionCount: 7,
      totalMinutes: 142,
      totalHints: 21,
      totalProblems: 9,
      avgSolveTimeMs: 47_210,
      periodStart: "2026-04-27T00:00:00Z",
      periodEnd: "2026-05-04T00:00:00Z",
    });
    expect(result).toEqual({
      sessionsThisWeek: 7,
      totalMinutes: 142,
      hintsPerSession: 3,
      avgSolveTimeMs: 47_210,
    });
  });

  it("guards against divide-by-zero when sessionCount is 0", () => {
    const result = aggregateFromLatestStats({
      sessionCount: 0,
      totalMinutes: 0,
      totalHints: 0,
      totalProblems: 0,
      avgSolveTimeMs: 0,
      periodStart: "2026-04-27T00:00:00Z",
      periodEnd: "2026-05-04T00:00:00Z",
    });
    expect(result.hintsPerSession).toBe(0);
  });
});
