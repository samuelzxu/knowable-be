// Fastify port of src/handlers/telemetry.ts.
//
//   POST /telemetry -> 200 { ok: true }
// 30-day TTL; allowlisted event types only.
// Auth (req.userId) is provided by the global preHandler in server.ts.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
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

const TelemetrySchema = z.object({
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  ts: z.string().optional(),
});

export function registerTelemetryRoute(fastify: FastifyInstance): void {
  fastify.post("/telemetry", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId;
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = TelemetrySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "missing required field: eventType" });
    }
    const { eventType, payload, ts } = parsed.data;

    if (!ALLOWED_EVENT_TYPES.has(eventType)) {
      return reply.code(400).send({
        error: "invalid_event_type",
        allowed: Array.from(ALLOWED_EVENT_TYPES),
      });
    }

    const timestamp = ts ?? new Date().toISOString();
    // TTL: 30 days from now (epoch seconds)
    const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    await putTelemetryEvent({
      userId,
      ts: timestamp,
      eventType,
      payload: payload ?? {},
      ttl,
    });

    return reply.code(200).send({ ok: true });
  });
}
