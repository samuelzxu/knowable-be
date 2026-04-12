import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { verifyJwt, extractBearerToken } from "../lib/auth.js";
import { getConfig } from "../lib/dynamo.js";

const CACHE_TTL_MS = 300_000; // 300 seconds (5 min default; plan says 300s in-memory)

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

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
  const token = extractBearerToken(event.headers?.["authorization"]);
  if (!token) return json(401, { error: "unauthorized" });

  try {
    await verifyJwt(token);
  } catch {
    return json(401, { error: "unauthorized" });
  }

  const configKey = event.queryStringParameters?.["key"];
  if (!configKey) {
    return json(400, { error: "missing required query param: key" });
  }

  // Check in-memory cache
  const cached = cache.get(configKey);
  if (cached && cached.expiresAt > Date.now()) {
    return json(200, { key: configKey, value: cached.value, cached: true });
  }

  const record = await getConfig(configKey);
  if (!record) {
    return json(404, { error: "config_key_not_found" });
  }

  // Update cache
  cache.set(configKey, { value: record.value, expiresAt: Date.now() + CACHE_TTL_MS });

  return json(200, { key: configKey, value: record.value, cached: false });
};
