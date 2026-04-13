import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { assertRegionAvailable, checkRegionOnColdStart } from "../lib/region-check.js";
import { invokeBedrock } from "../lib/bedrock.js";
import { verifyJwt, extractBearerToken } from "../lib/auth.js";
import { updateSessionContext } from "../lib/dynamo.js";
import type { AnthropicMessage } from "../lib/bedrock.js";

const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const MODEL_ID =
  process.env["BEDROCK_MODEL_ID"] ?? "anthropic.claude-3-5-sonnet-20241022-v2:0";

// Run region check on cold start
void checkRegionOnColdStart();

interface ContextRequestBody {
  image_base64: string;
  current_context: string;
  session_id: string;
}

const SYSTEM_PROMPT = `You are Milo, an AI tutor observing a student's notebook through their Mac's camera. Your job is to maintain a running description of what the student is working on.

Given the current image of their paper and your previous observations, produce an updated context summary that captures:
- What subject/topic they're working on
- The specific problem(s) visible
- All equations, expressions, graphs, or diagrams you can see
- What changed since the last observation (new work, erasures, corrections)
- Where the student appears to be in their problem-solving process
- Any signs of confusion, errors, or getting stuck

Be concise but thorough. Use mathematical notation where appropriate. This context will be used to generate targeted hints when the student needs help.

If this is the first observation (no previous context), describe everything you see from scratch.`;

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
  let body: ContextRequestBody;
  try {
    body = JSON.parse(event.body ?? "{}") as ContextRequestBody;
  } catch {
    return json(400, { error: "invalid_json" });
  }

  if (!body.image_base64) {
    return json(400, { error: "missing_required_fields", fields: ["image_base64"] });
  }

  // Build multimodal message
  const messages: AnthropicMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: body.image_base64,
          },
        },
        {
          type: "text",
          text: body.current_context
            ? `Previous context:\n${body.current_context}\n\nUpdate this context based on what you now see in the image.`
            : "This is the first observation. Describe everything you see on the paper.",
        },
      ],
    },
  ];

  // Invoke Bedrock
  let result;
  try {
    result = await invokeBedrock(messages, REGION, MODEL_ID, {
      system: SYSTEM_PROMPT,
      maxTokens: 500,
    });
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error.name === "RegionUnavailableError") {
      return json(503, { error: "ai_unavailable", reason: "bedrock_region_unavailable" });
    }
    console.error("[context] Bedrock error:", err);
    return json(502, { error: "bedrock_error" });
  }

  // Persist context to DynamoDB (best-effort, don't fail the request)
  if (body.session_id) {
    try {
      await updateSessionContext(userId, body.session_id, result.text);
    } catch (err) {
      console.warn("[context] Failed to persist context to DynamoDB:", err);
    }
  }

  return json(200, {
    updated_context: result.text,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  });
};
