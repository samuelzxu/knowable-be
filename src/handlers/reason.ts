import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { assertRegionAvailable, checkRegionOnColdStart } from "../lib/region-check.js";
import { invokeBedrock } from "../lib/bedrock.js";
import { verifyJwt, extractBearerToken } from "../lib/auth.js";
import { updateSessionAnalysis, putMessage } from "../lib/dynamo.js";
import type { AnthropicMessage, ContentBlock } from "../lib/bedrock.js";
import {
  SYSTEM_PROMPT,
  parseReasonResponse,
  type ReasonRequestBody,
} from "../lib/reason-common.js";
import { randomUUID } from "crypto";

// Re-export for existing consumers (tests) that imported parseReasonResponse
// from this module before the shared module existed.
export { parseReasonResponse };

const REGION = process.env["AWS_REGION"] ?? "us-east-1";
// Split by path: passive (vision) passes use Haiku 4.5 for throughput; active
// queries (text-only, force_reply) use Sonnet 4.6 for answer quality. Both
// fall back to the legacy REASON_MODEL_ID if set so older deployments keep
// working.
const LEGACY_REASON_MODEL_ID = process.env["REASON_MODEL_ID"];
const REASON_MODEL_ID_ACTIVE =
  process.env["REASON_MODEL_ID_ACTIVE"] ?? LEGACY_REASON_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6";
const REASON_MODEL_ID_PASSIVE =
  process.env["REASON_MODEL_ID_PASSIVE"] ?? LEGACY_REASON_MODEL_ID ?? "us.anthropic.claude-haiku-4-5";

// Run region check on cold start
void checkRegionOnColdStart();

interface ReasonResponse {
  understanding: string;
  events: string[];
  hint: string | null;
  hint_speech: string | null;
  state: "active" | "camera_lost" | "positioning_camera";
  tokensIn: number;
  tokensOut: number;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  // Auth
  const token = extractBearerToken(event.headers?.["authorization"]);
  if (!token) {
    return json(401, { error: "unauthorized" });
  }

  let userId: string;
  try {
    const claims = await verifyJwt(token);
    userId = claims.sub;
  } catch {
    return json(401, { error: "unauthorized" });
  }

  // Region check
  try {
    assertRegionAvailable();
  } catch {
    return json(503, { error: "ai_unavailable", reason: "bedrock_region_unavailable" });
  }

  // Parse body
  let body: ReasonRequestBody;
  try {
    body = JSON.parse(event.body ?? "{}") as ReasonRequestBody;
  } catch {
    return json(400, { error: "invalid_json" });
  }

  if (!body.frames || !Array.isArray(body.frames)) {
    return json(400, { error: "missing_required_fields", fields: ["frames"] });
  }
  // frames.length === 0 is allowed as a graceful-degradation path (e.g., the
  // camera briefly dropped during an active query). Must be paired with
  // force_reply + user_query — otherwise the model has nothing to do.
  const hasFrames = body.frames.length > 0;
  if (!hasFrames && (!body.flags?.force_reply || !body.flags?.user_query)) {
    return json(400, { error: "no_frames_requires_force_reply_and_query" });
  }
  const isForceReply = body.flags?.force_reply === true;

  // Build multimodal message content
  const priorAnalysis = body.current_analysis?.trim() || "(none yet — first pass)";
  const userQuery = body.flags?.user_query?.trim() || "(none)";

  const contentBlocks: ContentBlock[] = [];

  // Block 1: prior understanding
  contentBlocks.push({
    type: "text",
    text: `<prior_understanding>\n${priorAnalysis}\n</prior_understanding>`,
  });

  // Block 2: event log
  contentBlocks.push({
    type: "text",
    text: `<event_log>\n${body.event_log ?? ""}\n</event_log>`,
  });

  // Block 3: flags
  contentBlocks.push({
    type: "text",
    text: `<flags>\nis_milo_speaking: ${body.flags?.is_milo_speaking ?? false}\nsoft_muted: ${body.flags?.soft_muted ?? false}\nforce_reply: ${body.flags?.force_reply ?? false}\nuser_query: ${userQuery}\nsession_id: ${body.session_id ?? ""}\n</flags>`,
  });

  // Block 4+: frames (oldest first, as received). Active queries typically
  // send one frame; passive passes send up to three.
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

  // Final instruction block
  if (!hasFrames) {
    // Graceful degradation: camera is momentarily unavailable but the student
    // asked something. Answer from memory + event log WITHOUT telling the
    // student anything about frames or camera availability.
    contentBlocks.push({
      type: "text",
      text:
        "No image is available on this pass. Answer the student's user_query from prior UNDERSTANDING + event_log. " +
        "Do NOT mention anything about frames, camera availability, or repositioning — the student does not know frames are a concept. " +
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

  // Invoke Bedrock. Active queries (force_reply) route to Sonnet for answer
  // quality; passive observation passes route to Haiku for fast vision
  // throughput. Both paths may include frames.
  const modelId = isForceReply ? REASON_MODEL_ID_ACTIVE : REASON_MODEL_ID_PASSIVE;
  let result;
  try {
    result = await invokeBedrock(messages, REGION, modelId, {
      system: SYSTEM_PROMPT,
      maxTokens: 1000,
    });
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error.name === "RegionUnavailableError") {
      return json(503, { error: "ai_unavailable", reason: "bedrock_region_unavailable" });
    }
    console.error("[reason] Bedrock error:", err);
    return json(502, { error: "bedrock_error" });
  }

  // Parse the structured response
  const parsed = parseReasonResponse(result.text);

  // Persistence (best-effort)
  if (body.session_id) {
    try {
      await updateSessionAnalysis(userId, body.session_id, parsed.understanding);
    } catch (err) {
      console.warn("[reason] Failed to persist understanding to DynamoDB:", err);
    }

    if (parsed.hint) {
      const messageId = randomUUID();
      try {
        await putMessage({
          sessionId: body.session_id,
          sk: new Date().toISOString() + "#" + messageId,
          messageId,
          role: "milo",
          text: parsed.hint,
          timestamp: new Date().toISOString(),
          source: body.flags?.force_reply ? "active" : "passive",
        });
      } catch (err) {
        console.warn("[reason] Failed to persist hint message to DynamoDB:", err);
      }
    }
  }

  const response: ReasonResponse = {
    understanding: parsed.understanding,
    events: parsed.events,
    hint: parsed.hint,
    hint_speech: parsed.hint_speech,
    state: parsed.state,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  };

  return json(200, response);
};
