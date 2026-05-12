// Fine-tune trace capture.
//
// Saves (frames, request_context, sonnet_response) to S3 for later
// distillation of Sonnet 4.6 outputs into Gemma 4 E4B. Object layout:
//   traces/{YYYY-MM-DD}/{trace_uuid}/manifest.json
//   traces/{YYYY-MM-DD}/{trace_uuid}/frame-{i}.jpg
//
// Hard rule: must never throw or block the user-facing SSE stream. The
// caller `void`s the returned promise and we swallow every error after
// logging. A failed capture is a quietly dropped training example, never
// a degraded session.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

const REGION = process.env["AWS_REGION"] ?? "us-east-1";

// Lazy singleton: cold-start cost paid only when capture actually fires.
let _s3: S3Client | null = null;
function s3(): S3Client {
  if (!_s3) _s3 = new S3Client({ region: REGION });
  return _s3;
}

export interface CaptureInput {
  /** Cognito sub of the calling user (for provenance — not joined or filtered on). */
  userId: string;
  /** Session ID this trace belongs to. */
  sessionId: string;
  /** Bedrock model that generated the response. */
  modelId: string;
  /** Full system prompt as sent to Bedrock. Stored verbatim per trace so
   *  the dataset is self-contained even as the prompt evolves. */
  systemPrompt: string;
  /** Original request body (post-Zod-parse). */
  request: {
    eventLog: string;
    currentAnalysis: string;
    flags: {
      is_milo_speaking: boolean;
      force_reply: boolean;
      user_query?: string;
    };
    /** Base64-encoded JPEGs as the client sent them. */
    framesBase64: string[];
  };
  /** Sonnet's raw streamed text (everything the parser saw) plus the
   *  structured form extracted by the section parser. Storing both lets
   *  the extractor train on either the structured target or the raw text. */
  response: {
    rawText: string;
    parsed: {
      understanding: string;
      events: string[];
      hint: string | null;
      hintSpeech: string | null;
      state: string;
    };
  };
}

interface Manifest {
  trace_id: string;
  session_id: string;
  user_id: string;
  captured_at: string;
  model_id: string;
  system_prompt: string;
  system_prompt_sha256: string;
  request: {
    event_log: string;
    current_analysis: string;
    flags: {
      is_milo_speaking: boolean;
      force_reply: boolean;
      user_query?: string;
    };
    frame_count: number;
    frame_files: string[];
  };
  response: {
    raw_text: string;
    parsed: {
      understanding: string;
      events: string[];
      hint: string | null;
      hint_speech: string | null;
      state: string;
    };
  };
}

/**
 * Capture a trace to S3. Always resolves — errors are logged and swallowed.
 * Returns the trace ID so callers can correlate logs if needed.
 */
export async function captureTrace(input: CaptureInput): Promise<string | null> {
  const bucket = process.env["FINETUNE_TRACE_BUCKET"];
  if (!bucket) {
    // Capture infra not deployed in this environment.
    return null;
  }

  const traceId = randomUUID();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const prefix = `traces/${today}/${traceId}`;

  try {
    // 1. Decode + upload each frame as its own JPEG object.
    const frameFiles: string[] = [];
    for (let i = 0; i < input.request.framesBase64.length; i++) {
      const b64 = input.request.framesBase64[i];
      if (!b64) continue;
      const buf = Buffer.from(b64, "base64");
      const filename = `frame-${i}.jpg`;
      await s3().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${prefix}/${filename}`,
          Body: buf,
          ContentType: "image/jpeg",
        })
      );
      frameFiles.push(filename);
    }

    // 2. Build + upload manifest.
    const manifest: Manifest = {
      trace_id: traceId,
      session_id: input.sessionId,
      user_id: input.userId,
      captured_at: new Date().toISOString(),
      model_id: input.modelId,
      system_prompt: input.systemPrompt,
      system_prompt_sha256: createHash("sha256")
        .update(input.systemPrompt)
        .digest("hex"),
      request: {
        event_log: input.request.eventLog,
        current_analysis: input.request.currentAnalysis,
        flags: input.request.flags,
        frame_count: frameFiles.length,
        frame_files: frameFiles,
      },
      response: {
        raw_text: input.response.rawText,
        parsed: {
          understanding: input.response.parsed.understanding,
          events: input.response.parsed.events,
          hint: input.response.parsed.hint,
          // snake_case in the manifest mirrors the wire/handler convention
          // and the section header in Sonnet's output (HINT_SPEECH).
          hint_speech: input.response.parsed.hintSpeech,
          state: input.response.parsed.state,
        },
      },
    };

    await s3().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${prefix}/manifest.json`,
        Body: JSON.stringify(manifest, null, 2),
        ContentType: "application/json",
      })
    );

    console.log(`[trace-capture] saved trace ${traceId} (${frameFiles.length} frames)`);
    return traceId;
  } catch (err) {
    // Hard rule: never throw. A failed capture is a quietly dropped row.
    console.warn(`[trace-capture] failed to save trace ${traceId}:`, err);
    return null;
  }
}
