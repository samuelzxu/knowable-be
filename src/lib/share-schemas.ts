// Whitelisted Zod schemas for student → backend uploads.
// See .omc/design/educator-tools/02-architecture.md §3 for the wire format.
//
// All schemas use `.strict()` so any unrecognized field is rejected with a
// 400. This is the single source of truth for what may be uploaded; if a
// field isn't here, the upload is dropped. Notebook frames and verbatim
// problem text in particular MUST never appear in either schema.
//
// `endedAt`/`startedAt`/etc. live in §3.

import { z } from "zod";

// ---- Stats-only tier ---------------------------------------------------------

export const ShareStatsSchema = z
  .object({
    sessionCount: z.number().int().nonnegative().max(10_000),
    totalMinutes: z.number().nonnegative().max(1_000_000),
    totalHints: z.number().int().nonnegative().max(1_000_000),
    totalProblems: z.number().int().nonnegative().max(1_000_000),
    avgSolveTimeMs: z.number().nonnegative().max(86_400_000),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
  })
  .strict();

export type ShareStats = z.infer<typeof ShareStatsSchema>;

// ---- Stats + Activity tier ---------------------------------------------------
//
// Each list item is itself a `.strict()` shape so we can't smuggle the
// notebook frame buffer in via a nested `frame` attribute on an event row.

const TraceEventSchema = z
  .object({
    ts: z.string().max(16),
    type: z.string().max(64),
    description: z.string().max(2_000),
  })
  .strict();

const TraceUnderstandingSchema = z
  .object({
    ts: z.string().max(16),
    text: z.string().max(2_000),
  })
  .strict();

const TraceHintSchema = z
  .object({
    ts: z.string().max(16),
    text: z.string().max(2_000),
  })
  .strict();

export const ShareTraceSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    events: z.array(TraceEventSchema).max(500),
    understandings: z.array(TraceUnderstandingSchema).max(500),
    hints: z.array(TraceHintSchema).max(500),
  })
  .strict();

export type ShareTrace = z.infer<typeof ShareTraceSchema>;
