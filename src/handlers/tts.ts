import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { verifyJwt, extractBearerToken } from "../lib/auth.js";
import { getElevenLabsApiKey } from "../lib/elevenlabs.js";

const MAX_TEXT_LENGTH = 5000;

interface TTSRequestBody {
  text: string;
  voice_id?: string;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  // Auth
  const token = extractBearerToken(event.headers?.["authorization"]);
  if (!token) {
    return json(401, { error: "unauthorized" });
  }

  try {
    await verifyJwt(token);
  } catch {
    return json(401, { error: "unauthorized" });
  }

  // Parse body
  let body: TTSRequestBody;
  try {
    body = JSON.parse(event.body ?? "{}") as TTSRequestBody;
  } catch {
    return json(400, { error: "invalid_json" });
  }

  if (!body.text || typeof body.text !== "string" || body.text.trim().length === 0) {
    return json(400, { error: "missing_required_fields", fields: ["text"] });
  }

  if (body.text.length > MAX_TEXT_LENGTH) {
    return json(400, { error: "text_too_long", max: MAX_TEXT_LENGTH });
  }

  // Fetch ElevenLabs API key
  let apiKey: string;
  try {
    apiKey = await getElevenLabsApiKey();
  } catch (err) {
    console.error("[tts] Failed to fetch ElevenLabs API key:", err);
    return json(500, { error: "internal_error" });
  }

  // Call ElevenLabs streaming TTS API
  const voiceId = body.voice_id ?? process.env["ELEVENLABS_DEFAULT_VOICE_ID"] ?? "JBFqnCBsd6RMkjVDRZzb"; // "George" - warm male
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
    console.error("[tts] ElevenLabs request failed:", err);
    return json(502, { error: "tts_error" });
  }

  if (!response.ok) {
    const status = response.status;
    const errorBody = await response.text().catch(() => "(no body)");
    console.error(`[tts] ElevenLabs returned status ${status}: ${errorBody}`);
    console.error(`[tts] API key length: ${apiKey.length}, starts: ${apiKey.slice(0, 5)}`);
    // ElevenLabs returns 401 for both auth failures AND quota exceeded
    if (errorBody.includes("quota_exceeded") || status === 429) {
      return json(429, { error: "tts_quota_exceeded", detail: errorBody });
    }
    if (status === 401 || status === 403) {
      return json(502, { error: "tts_auth_failed", detail: errorBody });
    }
    return json(502, { error: "tts_error", detail: errorBody });
  }

  // Collect audio bytes and return as base64
  const audioBuffer = await response.arrayBuffer();
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "audio/mpeg",
    },
    body: Buffer.from(audioBuffer).toString("base64"),
    isBase64Encoded: true,
  };
};
