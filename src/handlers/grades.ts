import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { verifyJwt, extractBearerToken } from "../lib/auth.js";
import { putGrade, listGrades } from "../lib/dynamo.js";
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

  // POST /grades
  if (method === "POST") {
    let body: { subject?: string; score?: number };
    try {
      body = JSON.parse(event.body ?? "{}") as { subject?: string; score?: number };
    } catch {
      return json(400, { error: "invalid_json" });
    }

    if (!body.subject || body.score === undefined) {
      return json(400, { error: "missing required fields: subject, score" });
    }

    const gradeId = randomUUID();
    const now = new Date().toISOString();
    const record = { userId, gradeId, subject: body.subject, score: body.score, loggedAt: now };
    await putGrade(record);
    return json(201, record);
  }

  // GET /grades
  if (method === "GET") {
    const grades = await listGrades(userId);
    return json(200, { grades });
  }

  return json(405, { error: "method_not_allowed" });
};
