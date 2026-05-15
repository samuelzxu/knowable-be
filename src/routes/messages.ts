// Fastify port of src/handlers/messages.ts.
//
//   GET /messages?sessionId=... -> 200 { messages: [...] }
// Auth (req.userId) is provided by the global preHandler in server.ts.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { listMessages } from "../lib/dynamo.js";

export function registerMessagesRoute(fastify: FastifyInstance): void {
  fastify.get("/messages", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId;
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

    const query = req.query as { sessionId?: string };
    const sessionId = query.sessionId;
    if (!sessionId) {
      return reply
        .code(400)
        .send({ error: "missing_required_params", params: ["sessionId"] });
    }

    const messages = await listMessages(sessionId);
    return reply.code(200).send({ messages });
  });
}
