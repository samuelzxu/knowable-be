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
  // Lifecycle state (added to support pause/resume across devices).
  // Client patches `{ status: "paused", pausedAt, lastUnderstanding }`
  // on pause, and `{ status: "ended", endedAt, ... }` on end.
  status: z.enum(["active", "paused", "ended"]).optional(),
  pausedAt: z.string().optional(),
  lastUnderstanding: z.string().optional(),
});

export function registerSessionsRoutes(fastify: FastifyInstance): void {
  fastify.post("/sessions", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId;
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

    // Client may pass a UUID it has already minted locally (so the
    // CDSession.id and server sessionId match for clean upsert /
    // hydration round-tripping). If absent, fall back to a fresh
    // server-side UUID — preserves backward compatibility with any
    // caller that doesn't pre-mint.
    const body = (req.body ?? {}) as { sessionId?: string; startedAt?: string };
    const sessionId =
      typeof body.sessionId === "string" && body.sessionId.length > 0
        ? body.sessionId
        : randomUUID();
    const now = body.startedAt ?? new Date().toISOString();

    // Idempotent on the client-provided sessionId — if a row already
    // exists (re-issued from a flaky network retry, or from another
    // device's earlier POST), return the existing record verbatim so
    // we don't clobber lifecycle state set by a subsequent PATCH.
    const existing = await getSession(userId, sessionId);
    if (existing) {
      return reply.code(200).send(existing);
    }

    // Initialize status explicitly so the row is consistent with the
    // PATCH-driven lifecycle transitions (active -> paused -> ended).
    // Legacy rows without `status` are read as "active" by clients,
    // but new rows should carry the explicit value.
    await putSession({ userId, sessionId, startedAt: now, status: "active" });
    return reply.code(201).send({ sessionId, userId, startedAt: now, status: "active" });
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

      // Partial-update semantics: only the fields the caller passed
      // get overwritten. The previous implementation defaulted
      // `endedAt` to `now()` on any PATCH, which would inadvertently
      // end a session whenever the client patched anything else
      // (e.g. a pause). Each field is now opt-in.
      const updated = {
        ...existing,
        ...(updates.endedAt !== undefined && { endedAt: updates.endedAt }),
        ...(updates.hintsCount !== undefined && { hintsCount: updates.hintsCount }),
        ...(updates.problemsCount !== undefined && { problemsCount: updates.problemsCount }),
        ...(updates.avgTimeToSolveMs !== undefined && { avgTimeToSolveMs: updates.avgTimeToSolveMs }),
        ...(updates.status !== undefined && { status: updates.status }),
        ...(updates.pausedAt !== undefined && { pausedAt: updates.pausedAt }),
        ...(updates.lastUnderstanding !== undefined && { lastUnderstanding: updates.lastUnderstanding }),
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
