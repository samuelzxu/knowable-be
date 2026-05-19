// Append-only session-event timeline.
//
//   POST /sessions/:sessionId/events  { events: [{ id, type, timestampMs, payload? }, ...] }
//     -> 200 { written: <count>, unprocessed: <count> }
//     -> 400 if validation fails or > 25 events in one batch
//     -> 404 if the session isn't owned by the caller
//   GET  /sessions/:sessionId/events?after=<sk>&limit=500
//     -> 200 { events: [...], nextCursor: <sk> | null }
//     -> 404 if the session isn't owned by the caller
//
// Auth (req.userId) is provided by the global preHandler in server.ts.
// Ownership is enforced by a Get on knowable-sessions for (req.userId,
// sessionId) before any read or write — without this, anyone with a
// valid JWT could read or write events on any sessionId by guessing.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getSession,
  listSessionEvents,
  putSessionEventBatch,
  type SessionEventRecord,
} from "../lib/dynamo.js";

// Per-event payload cap. DynamoDB items are 400KB max; events are
// usually <2KB but a hint payload carrying full LaTeX can grow. The
// server rejects events whose serialized payload exceeds this so a
// single misbehaving client can't write 400KB rows.
const MAX_PAYLOAD_BYTES = 32 * 1024;

// 1 year in seconds — matches the table TTL we provision in Terraform.
const TTL_SECONDS = 365 * 24 * 60 * 60;

// Sortable timestamp prefix. 13 chars covers ms-since-epoch through
// year 5138, far longer than the 1y TTL needs.
const TS_PAD = 13;

const SessionEventInputSchema = z.object({
  // Client-generated stable id. The server composes the DynamoDB SK
  // as `${ts13}#${id}`, which means re-submitting an identical event
  // (same id + same timestamp) is an idempotent upsert — useful for
  // retry-after-network-blip on the writer queue.
  id: z.string().min(1).max(128),
  type: z.string().min(1).max(64),
  timestampMs: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const PostEventsSchema = z.object({
  events: z.array(SessionEventInputSchema).min(1).max(25),
});

function buildSk(timestampMs: number, id: string): string {
  return `${String(timestampMs).padStart(TS_PAD, "0")}#${id}`;
}

export function registerSessionEventsRoutes(fastify: FastifyInstance): void {
  fastify.post<{ Params: { sessionId: string } }>(
    "/sessions/:sessionId/events",
    async (req, reply) => {
      const userId = req.userId;
      if (!userId) return reply.code(401).send({ error: "unauthorized" });

      const { sessionId } = req.params;
      if (!sessionId) return reply.code(400).send({ error: "missing_path_params" });

      const parsed = PostEventsSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", issues: parsed.error.issues });
      }

      // Ownership precheck. 404 on miss doubles as "no such session"
      // without leaking whether the sessionId exists under a different
      // account.
      const session = await getSession(userId, sessionId);
      if (!session) return reply.code(404).send({ error: "not_found" });

      const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
      const records: SessionEventRecord[] = [];
      for (const e of parsed.data.events) {
        if (e.payload) {
          const size = Buffer.byteLength(JSON.stringify(e.payload));
          if (size > MAX_PAYLOAD_BYTES) {
            return reply.code(413).send({
              error: "payload_too_large",
              eventId: e.id,
              maxBytes: MAX_PAYLOAD_BYTES,
              actualBytes: size,
            });
          }
        }
        records.push({
          sessionId,
          sk: buildSk(e.timestampMs, e.id),
          userId,
          type: e.type,
          timestampMs: e.timestampMs,
          payload: e.payload,
          ttl,
        });
      }

      try {
        const unprocessed = await putSessionEventBatch(records);
        return reply.code(200).send({
          written: records.length - unprocessed.length,
          unprocessed: unprocessed.length,
        });
      } catch (err) {
        req.log.error({ err }, "[session-events] batch write failed");
        return reply.code(500).send({ error: "internal_error" });
      }
    }
  );

  fastify.get<{ Params: { sessionId: string }; Querystring: { after?: string; limit?: string } }>(
    "/sessions/:sessionId/events",
    async (req, reply) => {
      const userId = req.userId;
      if (!userId) return reply.code(401).send({ error: "unauthorized" });

      const { sessionId } = req.params;
      if (!sessionId) return reply.code(400).send({ error: "missing_path_params" });

      const session = await getSession(userId, sessionId);
      if (!session) return reply.code(404).send({ error: "not_found" });

      const limit =
        req.query.limit != null
          ? Math.min(parseInt(req.query.limit, 10) || 500, 1000)
          : 500;

      const { events, nextCursor } = await listSessionEvents(sessionId, {
        after: req.query.after,
        limit,
      });
      return reply.code(200).send({ events, nextCursor });
    }
  );
}
