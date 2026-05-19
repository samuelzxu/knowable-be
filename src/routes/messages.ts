// Chat message persistence + edit.
//
//   GET  /messages?sessionId=...&after=<sk>&limit=500
//     -> 200 { messages: [...], nextCursor: <sk> | null }
//   PUT  /messages/:sessionId/:sk  { text }
//     -> 200 (updated MessageRecord)
//     -> 403 if the row exists but role != "user" (can't edit Milo's
//        hints or system messages — enforced at the DDB layer via a
//        ConditionExpression on the UpdateItem)
//     -> 404 if the session isn't owned by the caller (or doesn't
//        exist), which doubles as the "no such message" response so
//        we don't leak existence-of-sessionId across accounts.
//
// Auth (req.userId) is provided by the global preHandler in server.ts.
// Both endpoints additionally verify ownership of the session via a
// Get on knowable-sessions for (req.userId, sessionId) — without this,
// any signed-in user could read or edit any other user's messages by
// guessing the sessionId.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { listMessages, updateMessageText, getSession } from "../lib/dynamo.js";

const PutMessageSchema = z.object({
  text: z.string().min(1).max(8000),
});

export function registerMessagesRoute(fastify: FastifyInstance): void {
  fastify.get("/messages", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId;
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

    const query = req.query as { sessionId?: string; after?: string; limit?: string };
    const sessionId = query.sessionId;
    if (!sessionId) {
      return reply
        .code(400)
        .send({ error: "missing_required_params", params: ["sessionId"] });
    }

    // Ownership precheck. 404 (not 403) on miss so we don't reveal
    // whether the sessionId exists under a different account.
    const session = await getSession(userId, sessionId);
    if (!session) return reply.code(404).send({ error: "not_found" });

    const limit = query.limit != null ? Math.min(parseInt(query.limit, 10) || 500, 1000) : 500;
    const { messages, nextCursor } = await listMessages(sessionId, {
      after: query.after,
      limit,
    });
    return reply.code(200).send({ messages, nextCursor });
  });

  fastify.put<{ Params: { sessionId: string; sk: string } }>(
    "/messages/:sessionId/:sk",
    async (req, reply) => {
      const userId = req.userId;
      if (!userId) return reply.code(401).send({ error: "unauthorized" });

      const { sessionId, sk } = req.params;
      if (!sessionId || !sk) {
        return reply.code(400).send({ error: "missing_path_params" });
      }

      const parsed = PutMessageSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }

      const session = await getSession(userId, sessionId);
      if (!session) return reply.code(404).send({ error: "not_found" });

      try {
        const updated = await updateMessageText(sessionId, sk, parsed.data.text);
        return reply.code(200).send(updated);
      } catch (err: unknown) {
        const error = err as { name?: string };
        if (error.name === "ConditionalCheckFailedException") {
          // Row exists but `role != "user"` (Milo / system message)
          // OR the row doesn't exist at all. Either way the caller
          // can't tell the difference, which is fine — both are 403
          // from their perspective.
          return reply
            .code(403)
            .send({ error: "not_editable", message: "Only your own messages can be edited." });
        }
        req.log.error({ err }, "[messages] PUT failed");
        return reply.code(500).send({ error: "internal_error" });
      }
    }
  );
}
