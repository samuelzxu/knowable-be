import { vi } from "vitest";

// Stub AWS SDK clients so unit tests never make real network calls

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  const BedrockRuntimeClient = vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [{ type: "text", text: "Milo here. Test hint response." }],
          usage: { input_tokens: 10, output_tokens: 20 },
        })
      ),
    }),
  }));

  const BedrockClient = vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ modelSummaries: [] }),
  }));

  const InvokeModelCommand = vi.fn().mockImplementation((input: unknown) => input);
  const ListFoundationModelsCommand = vi.fn().mockImplementation((input: unknown) => input);

  return {
    BedrockRuntimeClient,
    BedrockClient,
    InvokeModelCommand,
    ListFoundationModelsCommand,
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => {
  const DynamoDBClient = vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({}),
  }));

  const UpdateItemCommand = vi.fn().mockImplementation((input: unknown) => input);
  const GetItemCommand = vi.fn().mockImplementation((input: unknown) => input);
  const PutItemCommand = vi.fn().mockImplementation((input: unknown) => input);
  const QueryCommand = vi.fn().mockImplementation((input: unknown) => input);

  return {
    DynamoDBClient,
    UpdateItemCommand,
    GetItemCommand,
    PutItemCommand,
    QueryCommand,
  };
});

vi.mock("@aws-sdk/lib-dynamodb", () => {
  const DynamoDBDocumentClient = {
    from: vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({ Item: undefined, Items: [] }),
    }),
  };
  const PutCommand = vi.fn().mockImplementation((input: unknown) => input);
  const GetCommand = vi.fn().mockImplementation((input: unknown) => input);
  const QueryCommand = vi.fn().mockImplementation((input: unknown) => input);

  return { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand };
});

vi.mock("@aws-sdk/client-secrets-manager", () => {
  const SecretsManagerClient = vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ SecretString: "test-turnstile-secret" }),
  }));
  const GetSecretValueCommand = vi.fn().mockImplementation((input: unknown) => input);

  return { SecretsManagerClient, GetSecretValueCommand };
});

vi.mock("aws-jwt-verify", () => {
  return {
    CognitoJwtVerifier: {
      create: vi.fn().mockReturnValue({
        verify: vi.fn().mockResolvedValue({ sub: "test-user-id", email: "test@example.com" }),
      }),
    },
  };
});
