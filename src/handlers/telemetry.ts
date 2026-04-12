import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { verifyJwt, extractBearerToken } from "../lib/auth.js";
import { putTelemetryEvent } from "../lib/dynamo.js";

const ALLOWED_EVENT_TYPES = new Set([
  "signal_sample",
  "trigger_fired_shadow",
  "trigger_suppressed_cooldown",
  "hint_latency",
  "ocr_latency",
  "state_transition",
  "config_fetch_fallback",
]);

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface TelemetryBody {
  eventType: string;
  payload?: Record<string, unknown>;
  ts?: string;
}

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const token = extractBearerToken(event.headers?.["authorization"]);
  if (!token) return json(401, { error: "unauthorized" });

  let userId: string;
  try {
    const claims = await verifyJwt(token);
    userId = claims.sub;
  } catch {
    return json(401, { error: "unauthorized" });
  }

  let body: TelemetryBody;
  try {
    body = JSON.parse(event.body ?? "{}") as TelemetryBody;
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const { eventType, payload, ts } = body;

  if (!eventType) {
    return json(400, { error: "missing required field: eventType" });
  }

  if (!ALLOWED_EVENT_TYPES.has(eventType)) {
    return json(400, {
      error: "invalid_event_type",
      allowed: Array.from(ALLOWED_EVENT_TYPES),
    });
  }

  const timestamp = ts ?? new Date().toISOString();
  // TTL: 30 days from now
  const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

  await putTelemetryEvent({
    userId,
    ts: timestamp,
    eventType,
    payload: payload ?? {},
    ttl,
  });

  return json(200, { ok: true });
};
