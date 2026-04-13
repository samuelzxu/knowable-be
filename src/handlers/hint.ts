import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { assertRegionAvailable, checkRegionOnColdStart } from "../lib/region-check.js";
import { checkAndIncrementGlobalDailyQuota, checkAndIncrementUserDailyQuota } from "../lib/quota.js";
import { buildPassiveHintPrompt, buildActiveQueryPrompt } from "../lib/prompt.js";
import { invokeBedrock } from "../lib/bedrock.js";
import { verifyJwt, extractBearerToken } from "../lib/auth.js";

const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const MODEL_ID =
  process.env["BEDROCK_MODEL_ID"] ?? "anthropic.claude-3-5-sonnet-20241022-v2:0";

// Run region check on cold start
void checkRegionOnColdStart();

type HintSource = "passive_stuck" | "active_voice" | "active_text";

interface HintRequestBody {
  source: HintSource;
  problem_text: string;
  context?: string;
  transcript?: string;
  hint_history?: string[];
  user_query?: string;
  sessionId?: string;
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
  let body: HintRequestBody;
  try {
    body = JSON.parse(event.body ?? "{}") as HintRequestBody;
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const { source, problem_text, context, transcript, hint_history, user_query } = body;

  if (!source || !problem_text) {
    return json(400, { error: "missing_required_fields", fields: ["source", "problem_text"] });
  }

  const validSources: HintSource[] = ["passive_stuck", "active_voice", "active_text"];
  if (!validSources.includes(source)) {
    return json(400, { error: "invalid_source" });
  }

  if ((source === "active_voice" || source === "active_text") && !user_query) {
    return json(400, { error: "user_query required for active sources" });
  }

  // Global quota check first
  const globalQuota = await checkAndIncrementGlobalDailyQuota();
  if (!globalQuota.ok) {
    return json(429, { error: "quota_exceeded", reason: globalQuota.reason });
  }

  // Per-user quota check
  const userQuota = await checkAndIncrementUserDailyQuota(userId);
  if (!userQuota.ok) {
    return json(429, { error: "quota_exceeded", reason: userQuota.reason });
  }

  // Build prompt
  const hintHistoryArr = hint_history ?? [];
  let messages;
  if (source === "passive_stuck") {
    messages = buildPassiveHintPrompt({
      problem_text,
      transcript: transcript ?? "",
      hint_history: hintHistoryArr,
      context,
    });
  } else {
    messages = buildActiveQueryPrompt({
      problem_text,
      user_query: user_query ?? "",
      hint_history: hintHistoryArr,
      context,
    });
  }

  // Invoke Bedrock
  let result;
  try {
    result = await invokeBedrock(messages, REGION, MODEL_ID);
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error.name === "RegionUnavailableError") {
      return json(503, { error: "ai_unavailable", reason: "bedrock_region_unavailable" });
    }
    console.error("[hint] Bedrock error:", err);
    return json(502, { error: "bedrock_error" });
  }

  return json(200, {
    hint: result.text,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    source,
  });
};
