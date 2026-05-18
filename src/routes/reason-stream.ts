// Fastify port of src/handlers/reason-stream.ts.
//
// Same SSE contract — events in order:
//   understanding -> events -> hint_complete -> hint_speech_complete ->
//   state -> audio_start -> audio_chunk* -> audio_end -> tokens -> done.
// On error: event: error, then event: done, then end the stream.
// On TTS failure: skip audio_* events; client falls back to on-device TTS.
//
// We reuse src/lib/* directly — bedrock, elevenlabs, auth, dynamo,
// reason-common, reason-schemas, trace-capture — so the Fastify route and
// the Lambda handler stay byte-compatible at the SSE protocol level.
// Cutover (Phase 5) deletes the Lambda; until then they coexist.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { invokeBedrockStream } from "../lib/bedrock.js";
import type { AnthropicMessage, ContentBlock } from "../lib/bedrock.js";
import { verifyJwt, extractBearerToken } from "../lib/auth.js";
import { updateSessionAnalysis, putMessage } from "../lib/dynamo.js";
import { getElevenLabsApiKey } from "../lib/elevenlabs.js";
import { captureTrace } from "../lib/trace-capture.js";
import {
  SYSTEM_PROMPT,
  createStreamParser,
  parseEventsSection,
  parseStateSection,
} from "../lib/reason-common.js";
import {
  ReasonRequestSchema,
  SSEEventSchemas,
  normalizeHintField,
  type ReasonState,
  type SSEEventName,
  type SSEEventPayload,
} from "../lib/reason-schemas.js";
import { assertRegionAvailable } from "../lib/region-check.js";

const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const LEGACY_REASON_MODEL_ID = process.env["REASON_MODEL_ID"];
const REASON_MODEL_ID_ACTIVE =
  process.env["REASON_MODEL_ID_ACTIVE"] ?? LEGACY_REASON_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6";
const REASON_MODEL_ID_PASSIVE =
  process.env["REASON_MODEL_ID_PASSIVE"] ?? LEGACY_REASON_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6";
const ELEVENLABS_DEFAULT_VOICE_ID =
  process.env["ELEVENLABS_DEFAULT_VOICE_ID"] ?? "JBFqnCBsd6RMkjVDRZzb";

// Minimal SSE writable interface so the streaming helpers don't care
// whether they're emitting to Node `http.ServerResponse` (Fastify
// reply.raw) or any other writable. Mirrors the type in the Lambda
// handler so the SSE helper functions could be shared verbatim.
type SseWritable = {
  write: (chunk: string | Uint8Array) => boolean;
  end: () => void;
};

function sseEvent<N extends SSEEventName>(
  stream: SseWritable,
  event: N,
  data: SSEEventPayload<N>
): void {
  const schema = SSEEventSchemas[event];
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    console.error(`[reason-stream] refusing to emit invalid event=${event}:`, parsed.error.flatten());
    return;
  }
  try {
    const payload = `event: ${event}\ndata: ${JSON.stringify(parsed.data)}\n\n`;
    stream.write(payload);
  } catch (err) {
    console.warn(`[reason-stream] SSE write failed for event=${event}:`, err);
  }
}

function emitErrorAndClose(stream: SseWritable, code: string, message: string): void {
  sseEvent(stream, "error", { error: code, message });
  sseEvent(stream, "done", {});
  stream.end();
}

async function streamTtsToClient(
  stream: SseWritable,
  text: string,
  voiceId: string
): Promise<void> {
  let apiKey: string;
  try {
    apiKey = await getElevenLabsApiKey();
  } catch (err) {
    console.warn("[reason-stream] TTS disabled — failed to load API key:", err);
    return;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
      body: JSON.stringify({
        text,
        model_id: "eleven_flash_v2_5",
        output_format: "mp3_44100_128",
      }),
    });
  } catch (err) {
    console.warn("[reason-stream] ElevenLabs request failed:", err);
    return;
  }

  if (!resp.ok || !resp.body) {
    const body = await resp.text().catch(() => "(no body)");
    console.warn(`[reason-stream] ElevenLabs ${resp.status}: ${body.slice(0, 200)}`);
    return;
  }

  sseEvent(stream, "audio_start", { mime_type: "audio/mpeg" });

  const reader = resp.body.getReader();
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        sseEvent(stream, "audio_chunk", {
          base64: Buffer.from(value).toString("base64"),
        });
      }
    }
  } catch (err) {
    console.warn("[reason-stream] ElevenLabs stream read failed:", err);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }

  sseEvent(stream, "audio_end", {});
}

export function registerReasonStreamRoute(fastify: FastifyInstance): void {
  fastify.post(
    "/reason-stream",
    {
      // The Swift client sends 1-3 base64-encoded JPEG frames in the
      // body. Each frame is ~50-300 KB, so 1MB (Fastify default) is too
      // small. 25MB leaves headroom for future multi-frame growth.
      bodyLimit: 25 * 1024 * 1024,
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // ---- Auth ----
      // ALB strips no headers; Cognito tokens come through verbatim in
      // the Authorization header.
      const authHeaderRaw = req.headers["authorization"];
      const authHeader = typeof authHeaderRaw === "string" ? authHeaderRaw : undefined;
      const token = extractBearerToken(authHeader);
      if (!token) {
        return reply.code(401).send({ error: "unauthorized", message: "Missing bearer token" });
      }
      let userId: string;
      try {
        const claims = await verifyJwt(token);
        userId = claims.sub;
      } catch {
        return reply.code(401).send({ error: "unauthorized", message: "Invalid token" });
      }

      // ---- Region health (Bedrock cross-region inference availability)
      try {
        assertRegionAvailable();
      } catch {
        return reply
          .code(503)
          .send({ error: "bedrock_error", message: "Bedrock region unavailable" });
      }

      // ---- Body validation ----
      const bodyParse = ReasonRequestSchema.safeParse(req.body);
      if (!bodyParse.success) {
        req.log.warn({ errors: bodyParse.error.flatten() }, "[reason-stream] body validation failed");
        return reply.code(400).send({ error: "invalid_request_body" });
      }
      const body = bodyParse.data;
      const hasFrames = body.frames.length > 0;
      if (!hasFrames && (!body.flags.force_reply || !body.flags.user_query)) {
        return reply
          .code(400)
          .send({ error: "no_frames_requires_force_reply_and_query" });
      }
      const isForceReply = body.flags.force_reply;

      // ---- Switch to SSE mode ----
      // `reply.hijack()` tells Fastify "I'm taking over the raw socket"
      // so it doesn't try to send a response of its own afterwards.
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // `X-Accel-Buffering: no` is a hint for nginx-style proxies to
        // disable response buffering. The ALB doesn't buffer SSE, so
        // this is precautionary.
        "X-Accel-Buffering": "no",
      });

      const stream: SseWritable = {
        write: (chunk) => reply.raw.write(chunk),
        end: () => {
          if (!reply.raw.writableEnded) reply.raw.end();
        },
      };

      // If the Swift client disconnects mid-stream, stop writing — the
      // raw socket would otherwise eat events into an EPIPE later. We
      // can't currently propagate this into the Bedrock stream (the SDK
      // doesn't accept an AbortSignal from `invokeBedrockStream` today),
      // so we just stop emitting; tokens keep being read but never sent.
      let clientGone = false;
      req.raw.on("close", () => {
        clientGone = true;
      });
      // Wrap write() to bail when the client is gone.
      const guardedStream: SseWritable = {
        write: (chunk) => {
          if (clientGone) return false;
          return stream.write(chunk);
        },
        end: stream.end,
      };

      // ---- Build messages (identical to Lambda) ----
      const priorAnalysis = body.current_analysis.trim() || "(none yet - first pass)";
      const userQuery = body.flags.user_query?.trim() || "(none)";

      const contentBlocks: ContentBlock[] = [];
      contentBlocks.push({
        type: "text",
        text: `<prior_understanding>\n${priorAnalysis}\n</prior_understanding>`,
      });
      contentBlocks.push({
        type: "text",
        text: `<event_log>\n${body.event_log}\n</event_log>`,
      });
      contentBlocks.push({
        type: "text",
        text: `<flags>\nis_milo_speaking: ${body.flags.is_milo_speaking}\nforce_reply: ${body.flags.force_reply}\nuser_query: ${userQuery}\nsession_id: ${body.session_id}\n</flags>`,
      });

      body.frames.forEach((frame, i) => {
        contentBlocks.push({
          type: "text",
          text: `<frame index="${i}">`,
        });
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: frame,
          },
        });
      });

      // Optional second feed — the window the student is sharing via
      // ScreenCaptureKit on their Mac. Same temporal ordering as the
      // notebook frames (index 0 = oldest, last = "right now"). When
      // absent, skipping these blocks keeps the prompt structure
      // identical to the single-source case.
      (body.screen_frames ?? []).forEach((frame, i) => {
        contentBlocks.push({
          type: "text",
          text: `<screen_frame index="${i}">`,
        });
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: frame,
          },
        });
      });

      // Fast-path: when the student is actively waiting on an answer
      // (`force_reply=true` AND a non-empty `user_query`), skip the
      // UNDERSTANDING + EVENTS sections entirely. Cuts time-to-first-
      // hint-token from ~3-4s to ~1-1.5s because we no longer wait for
      // the model to fill the thinking buffer. The next passive pass
      // refreshes UNDERSTANDING; we accept slightly less-anchored hints
      // in exchange for dramatically lower perceived latency.
      const hasUserQuery = !!body.flags.user_query?.trim();
      const useFastPath = isForceReply && hasUserQuery;

      if (!hasFrames) {
        contentBlocks.push({
          type: "text",
          text:
            "No image is available on this pass. Answer the student's user_query from prior UNDERSTANDING + event_log. " +
            "Do NOT mention anything about frames, camera availability, or repositioning - the student does not know frames are a concept. " +
            "If you genuinely cannot answer without seeing the page, give your best inference from prior notes and invite them to show you. " +
            "FAST_REPLY MODE: Produce ONLY HINT, HINT_SPEECH, STATE in that exact order. Skip UNDERSTANDING and EVENTS — the passive loop will refresh them. The student is waiting. HINT and HINT_SPEECH must be non-empty.",
        });
      } else if (useFastPath) {
        contentBlocks.push({
          type: "text",
          text: "FAST_REPLY MODE: Produce ONLY HINT, HINT_SPEECH, STATE in that exact order. Skip UNDERSTANDING and EVENTS — the passive loop will refresh them. The student is waiting. HINT and HINT_SPEECH must be non-empty.",
        });
      } else if (isForceReply) {
        contentBlocks.push({
          type: "text",
          text: "Produce UNDERSTANDING, EVENTS, HINT, HINT_SPEECH, STATE in that exact order. force_reply=true on this pass, so HINT and HINT_SPEECH must be non-empty.",
        });
      } else {
        contentBlocks.push({
          type: "text",
          text: "Produce UNDERSTANDING, EVENTS, HINT, HINT_SPEECH, STATE in that exact order. force_reply=false on this pass, so leave HINT and HINT_SPEECH blank.",
        });
      }

      const messages: AnthropicMessage[] = [{ role: "user", content: contentBlocks }];
      const modelId = isForceReply ? REASON_MODEL_ID_ACTIVE : REASON_MODEL_ID_PASSIVE;

      // ---- Stream Bedrock ----
      let bedrockResult;
      try {
        bedrockResult = await invokeBedrockStream(messages, REGION, modelId, {
          system: SYSTEM_PROMPT,
          maxTokens: 1000,
        });
      } catch (err: unknown) {
        req.log.error({ err }, "[reason-stream] Bedrock invoke failed");
        const name = (err as { name?: string }).name;
        if (name === "RegionUnavailableError") {
          emitErrorAndClose(guardedStream, "bedrock_error", "region_unavailable");
        } else {
          emitErrorAndClose(guardedStream, "bedrock_error", "invoke_failed");
        }
        return;
      }

      let understanding = "";
      let eventsLines: string[] = [];
      let hintText: string | null = null;
      let hintSpeechText: string | null = null;
      let state: ReasonState = "active";
      let ttsPromise: Promise<void> | null = null;

      const parser = createStreamParser({
        // Emit token-level deltas for the HINT section only, AND only
        // when `force_reply` is true — passive passes have an empty
        // HINT section (just a "\n" between the `HINT:` header and the
        // `HINT_SPEECH:` header), and we'd otherwise emit a hint_delta
        // for that newline. The client would accumulate the whitespace
        // into a streaming bubble and never clear it (since the schema
        // rejects empty hint_complete events, `onHint` never fires on
        // passive passes — leaving a phantom blank bubble in the chat).
        onSectionDelta: (section, deltaText) => {
          if (section === "HINT" && deltaText.length > 0 && isForceReply) {
            sseEvent(guardedStream, "hint_delta", { text: deltaText });
          }
        },
        onSectionComplete: (section, text) => {
          switch (section) {
            case "UNDERSTANDING":
              understanding = text;
              sseEvent(guardedStream, "understanding", { text });
              break;
            case "EVENTS":
              eventsLines = parseEventsSection(text);
              sseEvent(guardedStream, "events", { lines: eventsLines });
              break;
            case "HINT": {
              const normalized = normalizeHintField(text);
              hintText = normalized;
              if (hintText) {
                sseEvent(guardedStream, "hint_complete", { text: hintText });
              }
              break;
            }
            case "HINT_SPEECH": {
              const normalized = normalizeHintField(text);
              hintSpeechText = normalized ?? hintText;
              if (hintSpeechText) {
                sseEvent(guardedStream, "hint_speech_complete", { text: hintSpeechText });
                if (body.tts !== "off") {
                  ttsPromise = streamTtsToClient(
                    guardedStream,
                    hintSpeechText,
                    ELEVENLABS_DEFAULT_VOICE_ID
                  );
                }
              }
              break;
            }
            case "STATE":
              state = parseStateSection(text);
              sseEvent(guardedStream, "state", { state });
              break;
          }
        },
      });

      try {
        for await (const delta of bedrockResult.deltas) {
          parser.push(delta);
        }
        parser.finalize();
      } catch (err) {
        req.log.error({ err }, "[reason-stream] Bedrock stream failed mid-flight");
        emitErrorAndClose(guardedStream, "bedrock_error", "stream_failed");
        return;
      }

      if (ttsPromise) {
        try {
          await ttsPromise;
        } catch (err) {
          req.log.warn({ err }, "[reason-stream] TTS pipeline threw");
        }
      }

      // ---- Persistence (best-effort) ----
      if (body.session_id) {
        // Don't overwrite the existing analysis with an empty string —
        // happens on FAST_REPLY passes that skip UNDERSTANDING. The
        // next passive pass refreshes the field.
        if (understanding) {
          try {
            await updateSessionAnalysis(userId, body.session_id, understanding);
          } catch (err) {
            req.log.warn({ err }, "[reason-stream] failed to persist understanding");
          }
        }
        if (hintText) {
          const messageId = randomUUID();
          try {
            await putMessage({
              sessionId: body.session_id,
              sk: new Date().toISOString() + "#" + messageId,
              messageId,
              role: "milo",
              text: hintText,
              timestamp: new Date().toISOString(),
              source: body.flags?.force_reply ? "active" : "passive",
            });
          } catch (err) {
            req.log.warn({ err }, "[reason-stream] failed to persist hint message");
          }
        }
      }

      // ---- Fine-tune trace capture (best-effort, never throws) ----
      if (body.capture) {
        await captureTrace({
          userId,
          sessionId: body.session_id,
          modelId,
          systemPrompt: SYSTEM_PROMPT,
          request: {
            eventLog: body.event_log,
            currentAnalysis: body.current_analysis,
            flags: {
              is_milo_speaking: body.flags?.is_milo_speaking ?? false,
              force_reply: body.flags?.force_reply ?? false,
              user_query: body.flags?.user_query,
            },
            framesBase64: body.frames,
          },
          response: {
            rawText: parser.getRaw(),
            parsed: {
              understanding,
              events: eventsLines,
              hint: hintText,
              hintSpeech: hintSpeechText,
              state,
            },
          },
        });
      }

      const usage = bedrockResult.getFinalUsage();
      sseEvent(guardedStream, "tokens", { input: usage.tokensIn, output: usage.tokensOut });
      sseEvent(guardedStream, "done", {});
      guardedStream.end();
    }
  );
}
