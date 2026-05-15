// Fastify port of src/handlers/grades.ts.
//
//   POST /grades -> 201 { userId, gradeId, subject, score, loggedAt }
//   GET  /grades -> 200 { grades: [...] }
// Auth (req.userId) is provided by the global preHandler in server.ts.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { putGrade, listGrades } from "../lib/dynamo.js";

const PostGradeSchema = z.object({
  subject: z.string().min(1),
  score: z.number(),
});

export function registerGradesRoutes(fastify: FastifyInstance): void {
  fastify.post("/grades", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId;
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = PostGradeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "missing required fields: subject, score" });
    }
    const body = parsed.data;

    const gradeId = randomUUID();
    const now = new Date().toISOString();
    const record = {
      userId,
      gradeId,
      subject: body.subject,
      score: body.score,
      loggedAt: now,
    };
    await putGrade(record);
    return reply.code(201).send(record);
  });

  fastify.get("/grades", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId;
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

    const grades = await listGrades(userId);
    return reply.code(200).send({ grades });
  });
}
