import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { verifyJwt, extractBearerToken } from "../lib/auth.js";
import { listMessages } from "../lib/dynamo.js";

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

  const sessionId = event.queryStringParameters?.["sessionId"];
  if (!sessionId) {
    return json(400, { error: "missing_required_params", params: ["sessionId"] });
  }

  const messages = await listMessages(sessionId);
  return json(200, { messages });
};
