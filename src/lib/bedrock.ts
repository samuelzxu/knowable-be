import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

export class RegionUnavailableError extends Error {
  constructor(region: string, modelId: string) {
    super(`Bedrock model ${modelId} unavailable in region ${region}`);
    this.name = "RegionUnavailableError";
  }
}

export interface BedrockResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

// Fallback chain: try each model ID in order until one works.
// Sonnet 4.6 is primary (fast + cheap + plenty smart). Opus 4.6 is the
// escalation. Sonnet 4.5 entries removed — the account has no marketplace
// subscription and they always 403.
const FALLBACK_MODELS = [
  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "us.anthropic.claude-sonnet-4-6",
  "anthropic.claude-sonnet-4-6",
  "us.anthropic.claude-opus-4-6-v1",
  "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
  "anthropic.claude-3-7-sonnet-20250219-v1:0",
  "us.anthropic.claude-3-5-haiku-20241022-v1:0",
];

export async function invokeBedrock(
  messages: AnthropicMessage[],
  region: string,
  modelId: string,
  options?: { system?: string; maxTokens?: number }
): Promise<BedrockResponse> {
  const client = new BedrockRuntimeClient({ region });

  const requestBody: Record<string, unknown> = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: options?.maxTokens ?? 1024,
    messages,
  };

  if (options?.system) {
    requestBody.system = options.system;
  }

  // Build the list of models to try: configured model first, then fallbacks
  const modelsToTry = [modelId, ...FALLBACK_MODELS.filter((m) => m !== modelId)];

  let lastError: unknown;

  for (const currentModelId of modelsToTry) {
    try {
      const command = new InvokeModelCommand({
        modelId: currentModelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(requestBody),
      });
      const response = await client.send(command);

      if (currentModelId !== modelId) {
        console.log(`[bedrock] Primary model ${modelId} failed; succeeded with fallback ${currentModelId}`);
      } else {
        console.log(`[bedrock] model=${currentModelId}`);
      }

      const bodyText = new TextDecoder().decode(response.body);
      const parsed = JSON.parse(bodyText) as {
        content: Array<{ type: string; text: string }>;
        usage: { input_tokens: number; output_tokens: number };
      };

      const textBlock = parsed.content.find((b) => b.type === "text");
      const text = textBlock?.text ?? "";

      return {
        text,
        tokensIn: parsed.usage.input_tokens,
        tokensOut: parsed.usage.output_tokens,
      };
    } catch (err: unknown) {
      const error = err as { $metadata?: { httpStatusCode?: number }; name?: string; message?: string };
      const status = error.$metadata?.httpStatusCode;
      const name = error.name ?? "";
      const msg = error.message ?? "";

      // If it's a model-not-found or invalid-model error, try the next fallback
      if (
        status === 404 ||
        name === "ValidationException" ||
        msg.includes("model identifier is invalid") ||
        msg.includes("on-demand throughput isn't supported")
      ) {
        console.log(`[bedrock] Model ${currentModelId} failed (${name}): ${msg.slice(0, 200)}, trying next fallback...`);
        lastError = err;
        continue;
      }

      // 403 could be IAM issue with this specific model/inference-profile format.
      // Try next fallback instead of aborting — a different model ID format may work.
      if (status === 403) {
        console.log(`[bedrock] Model ${currentModelId} got 403 (access denied), trying next fallback...`);
        lastError = err;
        continue;
      }

      // Any other error (throttling, server error, etc.) — don't fallback, throw immediately
      throw err;
    }
  }

  // All models exhausted
  console.error(`[bedrock] All model fallbacks exhausted. Last error:`, lastError);
  throw new RegionUnavailableError(region, modelId);

}

// ---- Streaming variant ----
//
// Mirrors invokeBedrock's model fallback chain but uses
// InvokeModelWithResponseStreamCommand. Yields plain text deltas as they
// arrive. When the stream ends, the final usage numbers are available via
// the returned StreamResult's getFinalUsage().

export interface BedrockStreamResult {
  /** Async iterator over text deltas from the model. */
  deltas: AsyncIterable<string>;
  /** After the stream has fully drained, returns the usage totals. */
  getFinalUsage: () => { tokensIn: number; tokensOut: number };
  /** The model ID that was actually used (may differ from requested via fallback). */
  modelIdUsed: string;
}

export async function invokeBedrockStream(
  messages: AnthropicMessage[],
  region: string,
  modelId: string,
  options?: { system?: string; maxTokens?: number }
): Promise<BedrockStreamResult> {
  const client = new BedrockRuntimeClient({ region });

  const requestBody: Record<string, unknown> = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: options?.maxTokens ?? 1024,
    messages,
  };
  if (options?.system) {
    requestBody.system = options.system;
  }

  const modelsToTry = [modelId, ...FALLBACK_MODELS.filter((m) => m !== modelId)];
  let lastError: unknown;

  for (const currentModelId of modelsToTry) {
    try {
      const command = new InvokeModelWithResponseStreamCommand({
        modelId: currentModelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(requestBody),
      });
      const response = await client.send(command);

      if (currentModelId !== modelId) {
        console.log(`[bedrock-stream] Primary model ${modelId} failed; succeeded with fallback ${currentModelId}`);
      } else {
        console.log(`[bedrock-stream] model=${currentModelId}`);
      }

      let tokensIn = 0;
      let tokensOut = 0;

      async function* iterator(): AsyncIterable<string> {
        if (!response.body) return;
        for await (const event of response.body) {
          if (event.chunk?.bytes) {
            const decoded = new TextDecoder().decode(event.chunk.bytes);
            // Bedrock wraps each event. For Anthropic, events are JSON with a
            // `type` field: message_start, content_block_start,
            // content_block_delta, content_block_stop, message_delta,
            // message_stop. Text deltas live in content_block_delta.delta.text.
            let parsed: {
              type?: string;
              delta?: { type?: string; text?: string; stop_reason?: string };
              message?: { usage?: { input_tokens?: number; output_tokens?: number } };
              usage?: { output_tokens?: number; input_tokens?: number };
            };
            try {
              parsed = JSON.parse(decoded);
            } catch {
              continue;
            }
            switch (parsed.type) {
              case "message_start":
                if (parsed.message?.usage) {
                  tokensIn = parsed.message.usage.input_tokens ?? 0;
                  tokensOut = parsed.message.usage.output_tokens ?? 0;
                }
                break;
              case "content_block_delta":
                if (parsed.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
                  yield parsed.delta.text;
                }
                break;
              case "message_delta":
                // Final usage update lives here.
                if (parsed.usage) {
                  if (typeof parsed.usage.output_tokens === "number") {
                    tokensOut = parsed.usage.output_tokens;
                  }
                  if (typeof parsed.usage.input_tokens === "number") {
                    tokensIn = parsed.usage.input_tokens;
                  }
                }
                break;
              default:
                break;
            }
          } else if (
            event.internalServerException ||
            event.modelStreamErrorException ||
            event.modelTimeoutException ||
            event.serviceUnavailableException ||
            event.throttlingException ||
            event.validationException
          ) {
            const e =
              event.internalServerException ??
              event.modelStreamErrorException ??
              event.modelTimeoutException ??
              event.serviceUnavailableException ??
              event.throttlingException ??
              event.validationException;
            throw new Error(`Bedrock stream error: ${JSON.stringify(e)}`);
          }
        }
      }

      return {
        deltas: iterator(),
        getFinalUsage: () => ({ tokensIn, tokensOut }),
        modelIdUsed: currentModelId,
      };
    } catch (err: unknown) {
      const error = err as { $metadata?: { httpStatusCode?: number }; name?: string; message?: string };
      const status = error.$metadata?.httpStatusCode;
      const name = error.name ?? "";
      const msg = error.message ?? "";

      if (
        status === 404 ||
        name === "ValidationException" ||
        msg.includes("model identifier is invalid") ||
        msg.includes("on-demand throughput isn't supported")
      ) {
        console.log(`[bedrock-stream] Model ${currentModelId} failed (${name}): ${msg.slice(0, 200)}, trying next fallback...`);
        lastError = err;
        continue;
      }

      if (status === 403) {
        console.log(`[bedrock-stream] Model ${currentModelId} got 403 (access denied), trying next fallback...`);
        lastError = err;
        continue;
      }

      throw err;
    }
  }

  console.error(`[bedrock-stream] All model fallbacks exhausted. Last error:`, lastError);
  throw new RegionUnavailableError(region, modelId);
}
