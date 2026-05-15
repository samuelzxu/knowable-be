// Fastify port of src/handlers/config.ts.
//
//   GET /config?key=... -> 200 { key, value, cached }
// 5-minute in-process cache, same as the Lambda. Auth (req.userId) is
// provided by the global preHandler in server.ts.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getConfig } from "../lib/dynamo.js";

const CACHE_TTL_MS = 300_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function registerConfigRoute(fastify: FastifyInstance): void {
  fastify.get("/config", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId;
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

    const query = req.query as { key?: string };
    const configKey = query.key;
    if (!configKey) {
      return reply.code(400).send({ error: "missing required query param: key" });
    }

    const cached = cache.get(configKey);
    if (cached && cached.expiresAt > Date.now()) {
      return reply.code(200).send({ key: configKey, value: cached.value, cached: true });
    }

    const record = await getConfig(configKey);
    if (!record) {
      return reply.code(404).send({ error: "config_key_not_found" });
    }

    cache.set(configKey, { value: record.value, expiresAt: Date.now() + CACHE_TTL_MS });

    return reply.code(200).send({ key: configKey, value: record.value, cached: false });
  });
}
