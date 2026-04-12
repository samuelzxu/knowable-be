import {
  BedrockRuntimeClient,
  InvokeModelCommand,
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

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text: string }>;
}

export async function invokeBedrock(
  messages: AnthropicMessage[],
  region: string,
  modelId: string
): Promise<BedrockResponse> {
  const client = new BedrockRuntimeClient({ region });

  const requestBody = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1024,
    messages,
  };

  let response;
  try {
    const command = new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(requestBody),
    });
    response = await client.send(command);
  } catch (err: unknown) {
    const error = err as { $metadata?: { httpStatusCode?: number }; name?: string };
    const status = error.$metadata?.httpStatusCode;
    if (status === 404 || status === 403) {
      throw new RegionUnavailableError(region, modelId);
    }
    throw err;
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
}
