//
// knowable-api Fastify server entry point.
//
// Runs in a Fargate task behind the knowable-api ALB. Listens on
// PORT (env, default 3000) and binds 0.0.0.0 because the task has a
// single ENI in the private subnet — the ALB connects by IP.
//
// All routes (except /health and /reason-stream which does its own
// auth-in-stream) require a valid Cognito ID token via the global
// preHandler below. Routes can assume `req.userId` is set.
//

import Fastify from 'fastify'
import { extractBearerToken, verifyJwt } from './lib/auth.js'
import { registerReasonStreamRoute } from './routes/reason-stream.js'
import { registerHintRoute } from './routes/hint.js'
import { registerTtsRoute } from './routes/tts.js'
import { registerSessionsRoutes } from './routes/sessions.js'
import { registerSessionEventsRoutes } from './routes/session-events.js'
import { registerMessagesRoute } from './routes/messages.js'
import { registerContextRoute } from './routes/context.js'
import { registerConfigRoute } from './routes/config.js'
import { registerWaitlistRoute } from './routes/waitlist.js'

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string
    userEmail?: string
  }
}

const PORT = Number(process.env.PORT ?? 3000)
const HOST = '0.0.0.0'

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  // ECS log driver tags each line — we don't need pino-pretty.
  // Defaults to JSON which CloudWatch ingests cleanly.
})

// Global auth preHandler. /health is public; /reason-stream verifies the
// JWT itself before switching to SSE mode (it has to keep the unauthorized
// response as plain JSON, not an SSE event); /waitlist is the public
// landing-page sign-up form, gated by Cloudflare Turnstile instead of a
// Cognito session.
fastify.addHook('preHandler', async (req, reply) => {
  const url = req.url.split('?')[0]
  if (url === '/health' || url === '/reason-stream' || url === '/waitlist') return
  const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
  const token = extractBearerToken(auth)
  if (!token) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Missing bearer token' })
  }
  try {
    const claims = await verifyJwt(token)
    req.userId = claims.sub
    req.userEmail = claims.email
  } catch {
    return reply.code(401).send({ error: 'unauthorized', message: 'Invalid token' })
  }
})

fastify.get('/health', async () => ({ ok: true }))
registerReasonStreamRoute(fastify)
registerHintRoute(fastify)
registerTtsRoute(fastify)
registerSessionsRoutes(fastify)
registerSessionEventsRoutes(fastify)
registerMessagesRoute(fastify)
registerContextRoute(fastify)
registerConfigRoute(fastify)
registerWaitlistRoute(fastify)

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
