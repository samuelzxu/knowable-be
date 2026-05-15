// Fastify port of src/handlers/context.ts.
//
// Multimodal Bedrock invoke — single base64 frame + prior context string.
// Body limit bumped to 5MB because the image_base64 field can be ~1MB+.
// Auth (req.userId) is provided by the global preHandler in server.ts.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { assertRegionAvailable } from "../lib/region-check.js";
import { invokeBedrock } from "../lib/bedrock.js";
import type { AnthropicMessage } from "../lib/bedrock.js";
import { updateSessionContext } from "../lib/dynamo.js";

const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const MODEL_ID =
  process.env["BEDROCK_MODEL_ID"] ?? "anthropic.claude-3-5-sonnet-20241022-v2:0";

const ContextRequestSchema = z.object({
  image_base64: z.string().min(1),
  current_context: z.string(),
  session_id: z.string(),
});

const SYSTEM_PROMPT = `You are Milo, an AI tutor observing a student's notebook through their Mac's camera. Your job is to maintain a running description of what the student is working on.

Given the current image of their paper and your previous observations, produce an updated context summary that captures:
- What subject/topic they're working on
- The specific problem(s) visible
- All equations, expressions, graphs, or diagrams you can see
- What changed since the last observation (new work, erasures, corrections)
- Where the student appears to be in their problem-solving process
- Any signs of confusion, errors, or getting stuck

Be concise but thorough. Use mathematical notation where appropriate. This context will be used to generate targeted hints when the student needs help.

If this is the first observation (no previous context), describe everything you see from scratch.

## Session States
You can suggest state transitions by including \\boxed{state_name} in your response. Valid states:
- active: student is actively working
- camera_lost: the paper/notebook is not visible or camera is obstructed
- positioning_camera: the camera needs repositioning (partially visible)

Only suggest a state change when clearly warranted. If the student is working normally, do not include a \\boxed{} tag.

## Event Log
The context includes a timestamped event log showing what has happened in the session so far. Use these timestamps to reason about timing — for example, if the student has been idle for 30 seconds, that's different from 3 seconds.`;

export function registerContextRoute(fastify: FastifyInstance): void {
  fastify.post(
    "/context",
    {
      // image_base64 can be ~1MB+ per the Lambda's real-world payload.
      bodyLimit: 5 * 1024 * 1024,
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = req.userId;
      if (!userId) return reply.code(401).send({ error: "unauthorized" });

      try {
        assertRegionAvailable();
      } catch {
        return reply
          .code(503)
          .send({ error: "ai_unavailable", reason: "bedrock_region_unavailable" });
      }

      const parsed = ContextRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "missing_required_fields", fields: ["image_base64"] });
      }
      const body = parsed.data;

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
                ? `Event log:\n${body.current_context}\n\nUpdate your analysis based on the current image and events.`
                : "This is the first observation. Describe everything you see on the paper.",
            },
          ],
        },
      ];

      let result;
      try {
        result = await invokeBedrock(messages, REGION, MODEL_ID, {
          system: SYSTEM_PROMPT,
          maxTokens: 500,
        });
      } catch (err: unknown) {
        const name = (err as { name?: string }).name;
        if (name === "RegionUnavailableError") {
          return reply
            .code(503)
            .send({ error: "ai_unavailable", reason: "bedrock_region_unavailable" });
        }
        req.log.error({ err }, "[context] Bedrock error");
        return reply.code(502).send({ error: "bedrock_error" });
      }

      if (body.session_id) {
        try {
          await updateSessionContext(userId, body.session_id, result.text);
        } catch (err) {
          req.log.warn({ err }, "[context] Failed to persist context to DynamoDB");
        }
      }

      return reply.code(200).send({
        updated_context: result.text,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      });
    }
  );
}
