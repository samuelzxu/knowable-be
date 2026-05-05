import { describe, it, expect } from "vitest";
import {
  ShareStatsSchema,
  ShareTraceSchema,
} from "../src/lib/share-schemas.js";

describe("ShareStatsSchema", () => {
  const valid = {
    sessionCount: 7,
    totalMinutes: 142,
    totalHints: 18,
    totalProblems: 9,
    avgSolveTimeMs: 47_210,
    periodStart: "2026-04-27T00:00:00Z",
    periodEnd: "2026-05-04T00:00:00Z",
  };

  it("accepts a valid stats blob", () => {
    const result = ShareStatsSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects extra fields (defense against frame-buffer smuggling)", () => {
    const tainted = { ...valid, frame: "base64-image" };
    const result = ShareStatsSchema.safeParse(tainted);
    expect(result.success).toBe(false);
  });

  it("rejects negative session counts", () => {
    const result = ShareStatsSchema.safeParse({ ...valid, sessionCount: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects malformed datetime strings", () => {
    const result = ShareStatsSchema.safeParse({
      ...valid,
      periodEnd: "yesterday",
    });
    expect(result.success).toBe(false);
  });
});

describe("ShareTraceSchema", () => {
  const valid = {
    sessionId: "uuid-1",
    startedAt: "2026-05-04T18:14:00Z",
    endedAt: "2026-05-04T18:51:00Z",
    events: [
      { ts: "00:10", type: "observed_write", description: "wrote x^2 + 5x = 0" },
    ],
    understandings: [
      { ts: "00:30", text: "Student is solving a quadratic." },
    ],
    hints: [{ ts: "01:20", text: "What value of x makes (x+2) = 0?" }],
  };

  it("accepts a valid trace", () => {
    const result = ShareTraceSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects an extra top-level field", () => {
    const tainted = { ...valid, notebookFrame: "leak" };
    const result = ShareTraceSchema.safeParse(tainted);
    expect(result.success).toBe(false);
  });

  it("rejects an extra field inside an event row", () => {
    const tainted = {
      ...valid,
      events: [
        {
          ts: "00:10",
          type: "observed_write",
          description: "ok",
          frame: "leak",
        },
      ],
    };
    const result = ShareTraceSchema.safeParse(tainted);
    expect(result.success).toBe(false);
  });

  it("rejects an extra field inside an understanding row", () => {
    const tainted = {
      ...valid,
      understandings: [
        { ts: "00:30", text: "ok", problemImage: "leak" },
      ],
    };
    const result = ShareTraceSchema.safeParse(tainted);
    expect(result.success).toBe(false);
  });
});
