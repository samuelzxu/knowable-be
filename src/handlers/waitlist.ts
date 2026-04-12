import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { putWaitlist } from "../lib/dynamo.js";
import { verifyTurnstileToken } from "../lib/turnstile.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SECRET_NAME = process.env["TURNSTILE_SECRET_NAME"] ?? "knowable/turnstile-secret";
const REGION = process.env["AWS_REGION"] ?? "us-east-1";

// 5-minute in-memory cache for the Turnstile secret
let cachedSecret: string | null = null;
let secretCacheExpiresAt = 0;
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;

let _secretsClient: SecretsManagerClient | null = null;

function getSecretsClient(): SecretsManagerClient {
  if (!_secretsClient) {
    _secretsClient = new SecretsManagerClient({ region: REGION });
  }
  return _secretsClient;
}

async function getTurnstileSecret(): Promise<string> {
  if (cachedSecret && Date.now() < secretCacheExpiresAt) {
    return cachedSecret;
  }

  const client = getSecretsClient();
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: SECRET_NAME })
  );

  const secret = response.SecretString;
  if (!secret) throw new Error("Turnstile secret is empty");

  cachedSecret = secret;
  secretCacheExpiresAt = Date.now() + SECRET_CACHE_TTL_MS;
  return secret;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface WaitlistBody {
  email?: string;
  turnstileToken?: string;
}

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  let body: WaitlistBody;
  try {
    body = JSON.parse(event.body ?? "{}") as WaitlistBody;
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const { email, turnstileToken } = body;

  // Validate email
  if (!email || !EMAIL_REGEX.test(email)) {
    return json(400, { error: "invalid_email" });
  }

  // Validate Turnstile token
  if (!turnstileToken) {
    return json(403, { error: "captcha_failed" });
  }

  let turnstileSecret: string;
  try {
    turnstileSecret = await getTurnstileSecret();
  } catch (err) {
    console.error("[waitlist] Failed to fetch Turnstile secret:", err);
    return json(500, { error: "internal_error" });
  }

  const sourceIp = event.requestContext.http.sourceIp;
  const verification = await verifyTurnstileToken(turnstileToken, turnstileSecret, sourceIp);
  if (!verification.success) {
    return json(403, { error: "captcha_failed", errorCodes: verification.errorCodes });
  }

  // Write to DynamoDB — idempotent via ConditionExpression attribute_not_exists(email)
  try {
    await putWaitlist({
      email,
      createdAt: new Date().toISOString(),
      sourceIp,
      userAgent: event.headers?.["user-agent"],
    });
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error.name === "ConditionalCheckFailedException") {
      // Duplicate — return success (idempotent)
      return json(200, { ok: true, duplicate: true });
    }
    console.error("[waitlist] DynamoDB error:", err);
    return json(500, { error: "internal_error" });
  }

  return json(200, { ok: true });
};
