// Fastify port of src/handlers/sessions.ts.
//
// Three endpoints, same shapes as the Lambda:
//   POST   /sessions       -> 201 { sessionId, userId, startedAt }
//   PATCH  /sessions/:id   -> 200 SessionRecord
//   GET    /sessions       -> 200 { sessions: [...] }
// Auth (req.userId) is provided by the global preHandler in server.ts.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { putSession, getSession, listSessions } from "../lib/dynamo.js";

const PatchSessionSchema = z.object({
  endedAt: z.string().optional(),
  hintsCount: z.number().optional(),
  problemsCount: z.number().optional(),
  avgTimeToSolveMs: z.number().optional(),
});

export function registerSessionsRoutes(fastify: FastifyInstance): void {
  fastify.post("/sessions", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId;
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

    const sessionId = randomUUID();
    const now = new Date().toISOString();
    await putSession({ userId, sessionId, startedAt: now });
    return reply.code(201).send({ sessionId, userId, startedAt: now });
  });

  fastify.patch<{ Params: { id: string } }>(
    "/sessions/:id",
    async (req, reply) => {
      const userId = req.userId;
      if (!userId) return reply.code(401).send({ error: "unauthorized" });

      const sessionId = req.params.id;
      if (!sessionId) return reply.code(400).send({ error: "missing session id" });

      const existing = await getSession(userId, sessionId);
      if (!existing) return reply.code(404).send({ error: "not_found" });

      const parsed = PatchSessionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_json" });
      }
      const updates = parsed.data;

      const updated = {
        ...existing,
        endedAt: updates.endedAt ?? new Date().toISOString(),
        hintsCount: updates.hintsCount ?? existing.hintsCount,
        problemsCount: updates.problemsCount ?? existing.problemsCount,
        avgTimeToSolveMs: updates.avgTimeToSolveMs ?? existing.avgTimeToSolveMs,
      };
      await putSession(updated);
      return reply.code(200).send(updated);
    }
  );

  fastify.get("/sessions", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId;
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

    const sessions = await listSessions(userId);
    return reply.code(200).send({ sessions });
  });
}
