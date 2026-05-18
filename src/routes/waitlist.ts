// Public waitlist sign-up route. Unlike the rest of the API, this
// endpoint is unauthenticated — the landing page calls it pre-signup,
// before the user has a Cognito session. Replaces the legacy Lambda
// handler that lived behind APIGW v2 (decommissioned with the ECS
// migration; the route never got ported and silently 404'd in prod).
//
//   POST /waitlist  -> 200 { ok: true }              (new email)
//                   -> 200 { ok: true, duplicate }   (idempotent)
//                   -> 400 { error: "invalid_email" | "invalid_json" }
//                   -> 403 { error: "captcha_failed" }
//                   -> 500 { error: "internal_error" }
//
// Abuse protection: a Cloudflare Turnstile token must accompany every
// submission. The site key is public; we verify the corresponding
// secret here against Cloudflare's siteverify endpoint.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { putWaitlist } from "../lib/dynamo.js";
import { verifyTurnstileToken } from "../lib/turnstile.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SECRET_NAME = process.env["TURNSTILE_SECRET_NAME"] ?? "knowable/turnstile-secret";
const REGION = process.env["AWS_REGION"] ?? "us-east-1";

// 5-minute in-memory cache for the Turnstile secret. The Secrets
// Manager API is rate-limited and the secret rarely rotates, so a
// per-task cache amortizes the lookup across submissions.
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

interface WaitlistBody {
  email?: string;
  turnstileToken?: string;
}

export function registerWaitlistRoute(fastify: FastifyInstance): void {
  fastify.post("/waitlist", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as WaitlistBody;
    const { email, turnstileToken } = body;

    if (!email || !EMAIL_REGEX.test(email)) {
      return reply.code(400).send({ error: "invalid_email" });
    }
    if (!turnstileToken) {
      return reply.code(403).send({ error: "captcha_failed" });
    }

    let turnstileSecret: string;
    try {
      turnstileSecret = await getTurnstileSecret();
    } catch (err) {
      req.log.error({ err }, "[waitlist] Failed to fetch Turnstile secret");
      return reply.code(500).send({ error: "internal_error" });
    }

    // Fastify exposes the originating IP via `req.ip` (honors the
    // trust-proxy chain; the ALB sets X-Forwarded-For).
    const sourceIp = req.ip;
    const verification = await verifyTurnstileToken(
      turnstileToken,
      turnstileSecret,
      sourceIp
    );
    if (!verification.success) {
      return reply.code(403).send({
        error: "captcha_failed",
        errorCodes: verification.errorCodes,
      });
    }

    const userAgent =
      typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"]
        : undefined;

    try {
      await putWaitlist({
        email,
        createdAt: new Date().toISOString(),
        sourceIp,
        userAgent,
      });
    } catch (err: unknown) {
      const error = err as { name?: string };
      if (error.name === "ConditionalCheckFailedException") {
        // Duplicate email — already on the waitlist. Return success so
        // the landing page UX is identical to a first-time submission
        // (no info leak about whether the address is registered).
        return reply.code(200).send({ ok: true, duplicate: true });
      }
      req.log.error({ err }, "[waitlist] DynamoDB error");
      return reply.code(500).send({ error: "internal_error" });
    }

    return reply.code(200).send({ ok: true });
  });
}
