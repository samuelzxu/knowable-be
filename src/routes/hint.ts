// Fastify port of src/handlers/hint.ts.
//
// Same response contract: { hint, tokensIn, tokensOut, source }.
// Auth (req.userId) is provided by the global preHandler in server.ts.
// Reuses lib/quota, lib/prompt, lib/bedrock, lib/dynamo — so the Lambda
// and the Fastify route behave identically at the API surface.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertRegionAvailable } from "../lib/region-check.js";
import {
  checkAndIncrementGlobalDailyQuota,
  checkAndIncrementUserDailyQuota,
} from "../lib/quota.js";
import { buildPassiveHintPrompt, buildActiveQueryPrompt } from "../lib/prompt.js";
import { invokeBedrock } from "../lib/bedrock.js";
import { putMessage, type MessageRecord } from "../lib/dynamo.js";

const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const MODEL_ID =
  process.env["BEDROCK_MODEL_ID"] ?? "anthropic.claude-3-5-sonnet-20241022-v2:0";

const HintRequestSchema = z.object({
  source: z.enum(["passive_stuck", "active_voice", "active_text"]),
  problem_text: z.string().min(1),
  context: z.string().optional(),
  transcript: z.string().optional(),
  hint_history: z.array(z.string()).optional(),
  user_query: z.string().optional(),
  sessionId: z.string().optional(),
});

export function registerHintRoute(fastify: FastifyInstance): void {
  fastify.post("/hint", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId;
    if (!userId) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    // Region check
    try {
      assertRegionAvailable();
    } catch {
      return reply
        .code(503)
        .send({ error: "ai_unavailable", reason: "bedrock_region_unavailable" });
    }

    // Body validation — match Lambda's error shape for the two failure modes
    const parsed = HintRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      const missing: string[] = [];
      if (flat.fieldErrors["source"]) missing.push("source");
      if (flat.fieldErrors["problem_text"]) missing.push("problem_text");
      if (missing.length > 0 && (!flat.fieldErrors["source"] || flat.fieldErrors["source"]?.[0]?.includes("Required"))) {
        return reply.code(400).send({ error: "missing_required_fields", fields: missing });
      }
      // source enum mismatch
      if (flat.fieldErrors["source"]) {
        return reply.code(400).send({ error: "invalid_source" });
      }
      return reply.code(400).send({ error: "missing_required_fields", fields: missing });
    }
    const body = parsed.data;
    const { source, problem_text, context, transcript, hint_history, user_query } = body;

    if ((source === "active_voice" || source === "active_text") && !user_query) {
      return reply.code(400).send({ error: "user_query required for active sources" });
    }

    // Global quota check first
    const globalQuota = await checkAndIncrementGlobalDailyQuota();
    if (!globalQuota.ok) {
      return reply.code(429).send({ error: "quota_exceeded", reason: globalQuota.reason });
    }

    // Per-user quota check
    const userQuota = await checkAndIncrementUserDailyQuota(userId);
    if (!userQuota.ok) {
      return reply.code(429).send({ error: "quota_exceeded", reason: userQuota.reason });
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
      const name = (err as { name?: string }).name;
      if (name === "RegionUnavailableError") {
        return reply
          .code(503)
          .send({ error: "ai_unavailable", reason: "bedrock_region_unavailable" });
      }
      req.log.error({ err }, "[hint] Bedrock error");
      return reply.code(502).send({ error: "bedrock_error" });
    }

    // Store chat messages best-effort (mirrors Lambda)
    const now = new Date().toISOString();
    const sessionId = body.sessionId ?? "unknown";

    const triggerMsg: MessageRecord = {
      sessionId,
      sk: `${now}#${randomUUID()}`,
      messageId: randomUUID(),
      role: source === "passive_stuck" ? "system" : "user",
      text:
        source === "passive_stuck"
          ? "[Student appears stuck]"
          : user_query ?? "[no query]",
      timestamp: now,
      source,
    };
    await putMessage(triggerMsg).catch((err) =>
      req.log.warn({ err }, "[hint] Failed to store trigger message")
    );

    const miloMsg: MessageRecord = {
      sessionId,
      sk: `${now}#${randomUUID()}`,
      messageId: randomUUID(),
      role: "milo",
      text: result.text,
      timestamp: now,
      source,
    };
    await putMessage(miloMsg).catch((err) =>
      req.log.warn({ err }, "[hint] Failed to store hint message")
    );

    return reply.code(200).send({
      hint: result.text,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      source,
    });
  });
}
