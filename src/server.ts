//
// knowable-api Fastify server entry point.
//
// Currently /health only. SSE routes for /reason-stream and the rest of
// the migrated endpoints will land in src/routes/* in Phase 3+.
//
// Runs in a Fargate task behind the knowable-api ALB. Listens on
// PORT (env, default 3000) and binds 0.0.0.0 because the task has a
// single ENI in the private subnet — the ALB connects by IP.
//

import Fastify from 'fastify'
import { registerReasonStreamRoute } from './routes/reason-stream.js'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = '0.0.0.0'

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  // ECS log driver tags each line — we don't need pino-pretty.
  // Defaults to JSON which CloudWatch ingests cleanly.
})

fastify.get('/health', async () => ({ ok: true }))
registerReasonStreamRoute(fastify)

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: HOST })
    fastify.log.info({ port: PORT }, 'knowable-api listening')
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

// ECS sends SIGTERM with a default 30s grace period before SIGKILL.
// `fastify.close()` drains in-flight requests (critical for SSE — a
// long-running reasoning stream would otherwise get cut mid-event).
const shutdown = async (signal: string) => {
  fastify.log.info({ signal }, 'shutdown requested')
  try {
    await fastify.close()
    process.exit(0)
  } catch (err) {
    fastify.log.error(err, 'graceful shutdown failed')
    process.exit(1)
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })

void start()
