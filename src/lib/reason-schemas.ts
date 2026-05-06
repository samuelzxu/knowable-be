// Zod schemas for the `/reason` pipeline. Validates (a) the incoming request
// body, (b) the structured output we parse out of Claude's text response, and
// (c) each SSE event payload emitted to the client. Keeping these in one place
// so both `reason.ts` (non-streaming) and `reason-stream.ts` (SSE) use the
// same contract.

import { z } from "zod";

// ---- Request body ------------------------------------------------------------

export const ReasonFlagsSchema = z.object({
  is_milo_speaking: z.boolean().default(false),
  force_reply: z.boolean().default(false),
  user_query: z.string().max(1000).optional(),
});

export const ReasonRequestSchema = z.object({
  frames: z.array(z.string()).max(8),
  event_log: z.string().max(20000).default(""),
  current_analysis: z.string().max(2000).default(""),
  flags: ReasonFlagsSchema,
  session_id: z.string().max(128).default(""),
  // "elevenlabs" → server generates + streams TTS audio (default).
  // "off"        → client will synthesize locally; server skips the
  //                ElevenLabs call to save cost and latency.
  tts: z.enum(["elevenlabs", "off"]).default("elevenlabs"),
});

export type ReasonRequest = z.infer<typeof ReasonRequestSchema>;

// ---- Parsed Claude response --------------------------------------------------

// Smaller models sometimes echo the description text from the prompt as a
// literal value ("(empty)", "N/A", "none") instead of leaving the field blank.
// Refinement drops these to null so TTS never fires on placeholder text.
const PLACEHOLDER = /^[\s\p{P}]*(empty|none|n\/?a|nothing|null|not applicable)[\s\p{P}]*$/iu;

function nonPlaceholderString(maxLen: number) {
  return z
    .string()
    .trim()
    .max(maxLen)
    .transform((s) => (s.length === 0 || PLACEHOLDER.test(s) ? null : s))
    .pipe(z.string().min(1).nullable());
}

/** Inline-use helper: normalize a raw hint/speech field to `string | null`
 *  with placeholder rejection. Returns `null` on validation failure rather
 *  than throwing — callers should treat as "no hint" on null. */
export function normalizeHintField(raw: string, maxLen: number = 500): string | null {
  const r = nonPlaceholderString(maxLen).safeParse(raw);
  return r.success ? r.data : null;
}

export const ReasonStateSchema = z.enum(["active", "camera_lost", "positioning_camera"]);

export type ReasonState = z.infer<typeof ReasonStateSchema>;

// Event lines Claude appends look like `[MM:SS] event_type: description`.
// Invalid lines are dropped rather than failing the whole pass (`catchall`
// behavior via z.preprocess so we filter before validating).
const EventLineSchema = z.string().regex(/^\[\d{2}:\d{2}\]\s+\w+:/, "invalid event line format");

export const ReasonResultSchema = z.object({
  understanding: z.string().trim().max(2000).default(""),
  events: z
    .preprocess(
      (val) => (Array.isArray(val) ? val.filter((l) => typeof l === "string" && /^\[\d{2}:\d{2}\]\s+\w+:/.test(l)) : []),
      z.array(EventLineSchema).max(20)
    )
    .default([]),
  hint: nonPlaceholderString(500),
  hint_speech: nonPlaceholderString(500),
  state: ReasonStateSchema.default("active"),
});

export type ReasonResult = z.infer<typeof ReasonResultSchema>;

// ---- SSE event payloads ------------------------------------------------------

export const SSEEventSchemas = {
  understanding: z.object({ text: z.string() }),
  events: z.object({ lines: z.array(z.string()) }),
  hint_delta: z.object({ text: z.string() }),
  hint_complete: z.object({ text: z.string().min(1) }),
  hint_speech_complete: z.object({ text: z.string().min(1) }),
  state: z.object({ state: ReasonStateSchema }),
  audio_start: z.object({ mime_type: z.string() }),
  audio_chunk: z.object({ base64: z.string().min(1) }),
  audio_end: z.object({}),
  tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }),
  done: z.object({}),
  error: z.object({ error: z.string(), message: z.string() }),
} as const;

export type SSEEventName = keyof typeof SSEEventSchemas;
export type SSEEventPayload<N extends SSEEventName> = z.infer<(typeof SSEEventSchemas)[N]>;
