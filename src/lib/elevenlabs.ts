import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const SECRET_NAME = process.env["ELEVENLABS_SECRET_NAME"] ?? "knowable/elevenlabs/secret";
const REGION = process.env["AWS_REGION"] ?? "us-east-1";

let cachedKey: string | null = null;
let keyCacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _secretsClient: SecretsManagerClient | null = null;

function getSecretsClient(): SecretsManagerClient {
  if (!_secretsClient) {
    _secretsClient = new SecretsManagerClient({ region: REGION });
  }
  return _secretsClient;
}

export async function getElevenLabsApiKey(): Promise<string> {
  if (cachedKey && Date.now() < keyCacheExpiresAt) {
    return cachedKey;
  }

  const client = getSecretsClient();
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: SECRET_NAME })
  );

  const secret = response.SecretString;
  if (!secret) throw new Error("ElevenLabs API key not found in Secrets Manager");

  cachedKey = secret;
  keyCacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return secret;
}
