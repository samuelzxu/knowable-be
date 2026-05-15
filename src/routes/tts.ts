// Fastify port of src/handlers/tts.ts.
//
// Keeps the Lambda's base64-in-JSON shape:
//   { audio: "<base64-mpeg>", isBase64Encoded: true }
// so the Swift client can A/B between Lambda and ECS without branching.
// Auth (req.userId) is provided by the global preHandler in server.ts.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getElevenLabsApiKey } from "../lib/elevenlabs.js";

const MAX_TEXT_LENGTH = 5000;

const TtsRequestSchema = z.object({
  text: z.string(),
  voice_id: z.string().optional(),
});

export function registerTtsRoute(fastify: FastifyInstance): void {
  fastify.post("/tts", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = TtsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "missing_required_fields", fields: ["text"] });
    }
    const body = parsed.data;

    if (!body.text || body.text.trim().length === 0) {
      return reply.code(400).send({ error: "missing_required_fields", fields: ["text"] });
    }
    if (body.text.length > MAX_TEXT_LENGTH) {
      return reply.code(400).send({ error: "text_too_long", max: MAX_TEXT_LENGTH });
    }

    // Fetch ElevenLabs API key
    let apiKey: string;
    try {
      apiKey = await getElevenLabsApiKey();
    } catch (err) {
      req.log.error({ err }, "[tts] Failed to fetch ElevenLabs API key");
      return reply.code(500).send({ error: "internal_error" });
    }

    const voiceId =
      body.voice_id ??
      process.env["ELEVENLABS_DEFAULT_VOICE_ID"] ??
      "JBFqnCBsd6RMkjVDRZzb";
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text: body.text,
          model_id: "eleven_flash_v2_5",
          output_format: "mp3_44100_128",
        }),
      });
    } catch (err) {
      req.log.error({ err }, "[tts] ElevenLabs request failed");
      return reply.code(502).send({ error: "tts_error" });
    }

    if (!response.ok) {
      const status = response.status;
      const errorBody = await response.text().catch(() => "(no body)");
      req.log.error(
        { status, errorBody: errorBody.slice(0, 200) },
        "[tts] ElevenLabs returned non-2xx"
      );
      if (errorBody.includes("quota_exceeded") || status === 429) {
        return reply.code(429).send({ error: "tts_quota_exceeded", detail: errorBody });
      }
      if (status === 401 || status === 403) {
        return reply.code(502).send({ error: "tts_auth_failed", detail: errorBody });
      }
      return reply.code(502).send({ error: "tts_error", detail: errorBody });
    }

    // Collect audio bytes and return as base64 in JSON — same shape as Lambda
    // so the Swift client doesn't need to branch.
    const audioBuffer = await response.arrayBuffer();
    const audio = Buffer.from(audioBuffer).toString("base64");
    return reply.code(200).send({ audio, isBase64Encoded: true });
  });
}
