import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { verifyJwt, extractBearerToken } from "../lib/auth.js";
import { putSession, getSession, listSessions } from "../lib/dynamo.js";
import { randomUUID } from "crypto";

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function authenticate(event: APIGatewayProxyEventV2): Promise<string | null> {
  const token = extractBearerToken(event.headers?.["authorization"]);
  if (!token) return null;
  try {
    const claims = await verifyJwt(token);
    return claims.sub;
  } catch {
    return null;
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const userId = await authenticate(event);
  if (!userId) return json(401, { error: "unauthorized" });

  const method = event.requestContext.http.method;
  const pathParams = event.pathParameters ?? {};

  // POST /sessions — create
  if (method === "POST") {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    await putSession({ userId, sessionId, startedAt: now });
    return json(201, { sessionId, userId, startedAt: now });
  }

  // PATCH /sessions/{id} — end session
  if (method === "PATCH") {
    const sessionId = pathParams["id"];
    if (!sessionId) return json(400, { error: "missing session id" });

    const existing = await getSession(userId, sessionId);
    if (!existing) return json(404, { error: "not_found" });

    let updates: Record<string, unknown> = {};
    try {
      updates = JSON.parse(event.body ?? "{}") as Record<string, unknown>;
    } catch {
      return json(400, { error: "invalid_json" });
    }

    const updated = {
      ...existing,
      endedAt: (updates["endedAt"] as string | undefined) ?? new Date().toISOString(),
      hintsCount: (updates["hintsCount"] as number | undefined) ?? existing.hintsCount,
      problemsCount: (updates["problemsCount"] as number | undefined) ?? existing.problemsCount,
      avgTimeToSolveMs: (updates["avgTimeToSolveMs"] as number | undefined) ?? existing.avgTimeToSolveMs,
    };
    await putSession(updated);
    return json(200, updated);
  }

  // GET /sessions — list
  if (method === "GET") {
    const sessions = await listSessions(userId);
    return json(200, { sessions });
  }

  return json(405, { error: "method_not_allowed" });
};
