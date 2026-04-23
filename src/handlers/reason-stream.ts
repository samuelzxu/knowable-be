// Streaming /reason-stream handler for Lambda Function URL with
// InvokeMode.RESPONSE_STREAM. Streams Bedrock tokens as SSE events and
// pipelines ElevenLabs TTS in parallel once HINT_SPEECH completes, so the
// client can start audio playback 3-4s earlier than the non-streaming
// /reason endpoint.
//
// Contract (documented in the deliverable): events in order are
//   understanding -> events -> hint_complete -> hint_speech_complete ->
//   state -> audio_start -> audio_chunk* -> audio_end -> tokens -> done.
// We skip hint_delta for the MVP (the TTS parallelism is the main win).
// On any error we emit `event: error` then `event: done` and close.
// On TTS failure we simply skip the audio_* events and continue with
// tokens + done - the client then falls back to on-device TTS. This is
// the simpler of the two options described in the task brief.
//
// Auth: Function URL has authorization_type=NONE, so we do JWT verification
// INSIDE the handler against the existing Cognito pool. Failing auth still
// emits a clean stream (event: error "unauthorized" -> event: done).

import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { checkRegionOnColdStart, assertRegionAvailable } from "../lib/region-check.js";

// The AWS Node 20 Lambda runtime exposes an `awslambda` global when the
// function is configured with a Function URL in RESPONSE_STREAM mode.
// @types/aws-lambda declares the types only when the module is imported
// (even as a side-effect import), which esbuild tries to bundle. We
// instead declare the minimal shape we need locally to keep the bundle
// free of the aws-lambda runtime package (it's dev-types-only).
declare const awslambda: {
  streamifyResponse: <TEvent = unknown>(
    handler: (event: TEvent, responseStream: NodeJS.WritableStream & {
      setContentType: (type: string) => void;
    }, context: Context) => Promise<void>
  ) => (event: TEvent, responseStream: unknown, context: Context) => Promise<void>;
  HttpResponseStream: {
    from: (
      writable: NodeJS.WritableStream,
      metadata: { statusCode?: number; headers?: Record<string, string> }
    ) => NodeJS.WritableStream & { setContentType: (type: string) => void };
  };
};
import { invokeBedrockStream } from "../lib/bedrock.js";
import type { AnthropicMessage, ContentBlock } from "../lib/bedrock.js";
import { verifyJwt, extractBearerToken } from "../lib/auth.js";
import { updateSessionAnalysis, putMessage } from "../lib/dynamo.js";
import { getElevenLabsApiKey } from "../lib/elevenlabs.js";
import {
  SYSTEM_PROMPT,
  createStreamParser,
  parseEventsSection,
  parseStateSection,
  type ReasonRequestBody,
  type ReasonState,
} from "../lib/reason-common.js";
import { randomUUID } from "node:crypto";

// Minimal interface the SSE helpers need. Both Node's Writable and the
// awslambda HttpResponseStream (which wraps a Writable) satisfy this.
type SseWritable = {
  write: (chunk: string | Uint8Array) => boolean;
  end: () => void;
};

const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const LEGACY_REASON_MODEL_ID = process.env["REASON_MODEL_ID"];
const REASON_MODEL_ID_ACTIVE =
  process.env["REASON_MODEL_ID_ACTIVE"] ?? LEGACY_REASON_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6";
const REASON_MODEL_ID_PASSIVE =
  process.env["REASON_MODEL_ID_PASSIVE"] ?? LEGACY_REASON_MODEL_ID ?? "us.anthropic.claude-haiku-4-5";

const ELEVENLABS_DEFAULT_VOICE_ID =
  process.env["ELEVENLABS_DEFAULT_VOICE_ID"] ?? "JBFqnCBsd6RMkjVDRZzb";

// Run region probe on cold start (non-blocking).
void checkRegionOnColdStart();

// ---- SSE helpers ----

function sseEvent(stream: SseWritable, event: string, data: unknown): void {
  // Best-effort write. If the stream has ended already, swallow.
  try {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    stream.write(payload);
  } catch (err) {
    console.warn(`[reason-stream] SSE write failed for event=${event}:`, err);
  }
}

function emitErrorAndClose(
  stream: SseWritable,
  code: string,
  message: string
): void {
  sseEvent(stream, "error", { error: code, message });
  sseEvent(stream, "done", {});
  stream.end();
}

// ---- ElevenLabs streaming TTS ----
//
// On success we pump audio chunks straight to the SSE stream as base64.
// On any failure we skip audio_* events (documented choice: simpler than
// the "non-terminal error then continue" alternative).

async function streamTtsToClient(
  stream: SseWritable,
  text: string,
  voiceId: string
): Promise<void> {
  let apiKey: string;
  try {
    apiKey = await getElevenLabsApiKey();
  } catch (err) {
    console.warn("[reason-stream] TTS disabled - failed to load API key:", err);
    return;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
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

  // Pump bytes as base64 chunks.
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
    // Still close the audio segment cleanly - the client's state machine
    // needs an audio_end to know the segment is over.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }

  sseEvent(stream, "audio_end", {});
}

// ---- Main handler ----

export const handler = awslambda.streamifyResponse(
  async (event: APIGatewayProxyEventV2, responseStream) => {
    // Set SSE content type. Function URLs wrap the stream via the
    // HttpResponseStream.from() helper when you want to include metadata
    // (status code, headers). We rely on setContentType() which sets the
    // right header under the hood.
    const httpStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });

    // ---- Auth ----
    // Function URLs lowercase headers; handle both just in case.
    const authHeader =
      event.headers?.["authorization"] ?? event.headers?.["Authorization"] ?? undefined;
    const token = extractBearerToken(authHeader);
    if (!token) {
      emitErrorAndClose(httpStream, "unauthorized", "Missing bearer token");
      return;
    }

    let userId: string;
    try {
      const claims = await verifyJwt(token);
      userId = claims.sub;
    } catch {
      emitErrorAndClose(httpStream, "unauthorized", "Invalid token");
      return;
    }

    try {
      assertRegionAvailable();
    } catch {
      emitErrorAndClose(httpStream, "bedrock_error", "Bedrock region unavailable");
      return;
    }

    // ---- Body ----
    let body: ReasonRequestBody;
    try {
      body = JSON.parse(event.body ?? "{}") as ReasonRequestBody;
    } catch {
      emitErrorAndClose(httpStream, "internal", "invalid_json");
      return;
    }

    if (!body.frames || !Array.isArray(body.frames)) {
      emitErrorAndClose(httpStream, "internal", "missing_required_fields: frames");
      return;
    }
    const hasFrames = body.frames.length > 0;
    if (!hasFrames && (!body.flags?.force_reply || !body.flags?.user_query)) {
      emitErrorAndClose(httpStream, "internal", "no_frames_requires_force_reply_and_query");
      return;
    }
    const isForceReply = body.flags?.force_reply === true;

    // ---- Build messages (identical to /reason) ----
    const priorAnalysis = body.current_analysis?.trim() || "(none yet - first pass)";
    const userQuery = body.flags?.user_query?.trim() || "(none)";

    const contentBlocks: ContentBlock[] = [];

    contentBlocks.push({
      type: "text",
      text: `<prior_understanding>\n${priorAnalysis}\n</prior_understanding>`,
    });
    contentBlocks.push({
      type: "text",
      text: `<event_log>\n${body.event_log ?? ""}\n</event_log>`,
    });
    contentBlocks.push({
      type: "text",
      text: `<flags>\nis_milo_speaking: ${body.flags?.is_milo_speaking ?? false}\nsoft_muted: ${body.flags?.soft_muted ?? false}\nforce_reply: ${body.flags?.force_reply ?? false}\nuser_query: ${userQuery}\nsession_id: ${body.session_id ?? ""}\n</flags>`,
    });

    for (let i = 0; i < body.frames.length; i++) {
      contentBlocks.push({
        type: "text",
        text: `<frame index="${i}">`,
      });
      contentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: body.frames[i],
        },
      });
    }

    if (!hasFrames) {
      contentBlocks.push({
        type: "text",
        text:
          "No image is available on this pass. Answer the student's user_query from prior UNDERSTANDING + event_log. " +
          "Do NOT mention anything about frames, camera availability, or repositioning - the student does not know frames are a concept. " +
          "If you genuinely cannot answer without seeing the page, give your best inference from prior notes and invite them to show you. " +
          "Produce UNDERSTANDING (keep or lightly update prior), EVENTS, HINT, HINT_SPEECH, STATE in that exact order. HINT is required.",
      });
    } else {
      contentBlocks.push({
        type: "text",
        text: "Produce UNDERSTANDING, EVENTS, HINT, HINT_SPEECH, STATE in that exact order.",
      });
    }

    const messages: AnthropicMessage[] = [
      {
        role: "user",
        content: contentBlocks,
      },
    ];

    const modelId = isForceReply ? REASON_MODEL_ID_ACTIVE : REASON_MODEL_ID_PASSIVE;

    // ---- Stream Bedrock ----
    let bedrockResult;
    try {
      bedrockResult = await invokeBedrockStream(messages, REGION, modelId, {
        system: SYSTEM_PROMPT,
        maxTokens: 1000,
      });
    } catch (err: unknown) {
      console.error("[reason-stream] Bedrock invoke failed:", err);
      const name = (err as { name?: string }).name;
      if (name === "RegionUnavailableError") {
        emitErrorAndClose(httpStream, "bedrock_error", "region_unavailable");
      } else {
        emitErrorAndClose(httpStream, "bedrock_error", "invoke_failed");
      }
      return;
    }

    // Section accumulators
    let understanding = "";
    let eventsLines: string[] = [];
    let hintText: string | null = null;
    let hintSpeechText: string | null = null;
    let state: ReasonState = "active";

    // TTS promise: kicked off when HINT_SPEECH completes so it pipelines
    // alongside STATE generation. We await it before emitting tokens+done.
    let ttsPromise: Promise<void> | null = null;

    const parser = createStreamParser({
      onSectionComplete: (section, text) => {
        switch (section) {
          case "UNDERSTANDING":
            understanding = text;
            sseEvent(httpStream, "understanding", { text });
            break;
          case "EVENTS":
            eventsLines = parseEventsSection(text);
            sseEvent(httpStream, "events", { lines: eventsLines });
            break;
          case "HINT": {
            const trimmed = text.trim();
            hintText = trimmed.length > 0 ? trimmed : null;
            if (hintText) {
              sseEvent(httpStream, "hint_complete", { text: hintText });
            }
            break;
          }
          case "HINT_SPEECH": {
            const trimmed = text.trim();
            const fallback = hintText;
            // If HINT_SPEECH empty but HINT non-empty, fall back to HINT
            // (client sanitizes forbidden chars). Matches reason.ts behavior.
            hintSpeechText = trimmed.length > 0 ? trimmed : fallback;
            if (hintSpeechText) {
              sseEvent(httpStream, "hint_speech_complete", { text: hintSpeechText });
              // Fire TTS in parallel with the remaining Bedrock generation
              // (STATE section). This is the core latency win.
              ttsPromise = streamTtsToClient(
                httpStream,
                hintSpeechText,
                ELEVENLABS_DEFAULT_VOICE_ID
              );
            }
            break;
          }
          case "STATE":
            state = parseStateSection(text);
            sseEvent(httpStream, "state", { state });
            break;
        }
      },
    });

    try {
      for await (const delta of bedrockResult.deltas) {
        parser.push(delta);
      }
      parser.finalize();
      console.log(
        "[reason-stream] hint=%j hint_speech=%j state=%s audio=%s",
        hintText?.slice(0, 120) ?? null,
        hintSpeechText?.slice(0, 120) ?? null,
        state,
        ttsPromise ? "fired" : "skipped"
      );
    } catch (err) {
      console.error("[reason-stream] Bedrock stream failed mid-flight:", err);
      emitErrorAndClose(httpStream, "bedrock_error", "stream_failed");
      return;
    }

    // If the model emitted STATE in our accumulator but we never fired the
    // state SSE event (e.g. because the parser completed it on finalize),
    // the callback above already handled it. Nothing to do here.

    // ---- Await TTS before tokens/done ----
    if (ttsPromise) {
      try {
        await ttsPromise;
      } catch (err) {
        console.warn("[reason-stream] TTS pipeline threw:", err);
        // Audio events may be partially emitted; continue to tokens/done.
      }
    }

    // ---- Persistence (best-effort) ----
    if (body.session_id) {
      try {
        await updateSessionAnalysis(userId, body.session_id, understanding);
      } catch (err) {
        console.warn("[reason-stream] Failed to persist understanding:", err);
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
          console.warn("[reason-stream] Failed to persist hint message:", err);
        }
      }
    }

    // ---- Tokens + done ----
    const usage = bedrockResult.getFinalUsage();
    sseEvent(httpStream, "tokens", { input: usage.tokensIn, output: usage.tokensOut });
    sseEvent(httpStream, "done", {});
    httpStream.end();
  }
);
