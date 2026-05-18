import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_SESSIONS = process.env["DYNAMODB_TABLE_SESSIONS"] ?? "knowable-sessions";
const TABLE_WAITLIST = process.env["DYNAMODB_TABLE_WAITLIST"] ?? "knowable-waitlist";
const TABLE_CONFIG = process.env["DYNAMODB_TABLE_CONFIG"] ?? "knowable-config";
const TABLE_MESSAGES = process.env["DYNAMODB_TABLE_MESSAGES"] ?? "knowable-messages";

// Educator tools (v0). Exported so the new roles/classes lib modules
// reference table names through this single source of truth.
export const TABLE_ROLES = process.env["DYNAMODB_TABLE_ROLES"] ?? "knowable-roles";
export const TABLE_CLASSES = process.env["DYNAMODB_TABLE_CLASSES"] ?? "knowable-classes";
export const TABLE_CLASS_MEMBERS =
  process.env["DYNAMODB_TABLE_CLASS_MEMBERS"] ?? "knowable-class-members";
export const TABLE_SESSION_TRACES =
  process.env["DYNAMODB_TABLE_SESSION_TRACES"] ?? "knowable-session-traces";
export const TABLE_ANALYSES =
  process.env["DYNAMODB_TABLE_ANALYSES"] ?? "knowable-analyses";
export const TABLE_EDUCATOR_INVITES =
  process.env["DYNAMODB_TABLE_EDUCATOR_INVITES"] ?? "knowable-educator-invites";

let _client: DynamoDBDocumentClient | null = null;

export function getDocumentClient(): DynamoDBDocumentClient {
  if (!_client) {
    const ddb = new DynamoDBClient({ region: process.env["AWS_REGION"] ?? "us-east-1" });
    _client = DynamoDBDocumentClient.from(ddb, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _client;
}

export interface SessionRecord {
  userId: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  hintsCount?: number;
  problemsCount?: number;
  avgTimeToSolveMs?: number;
  context?: string;
  contextUpdatedAt?: string;
  currentAnalysis?: string;
  analysisUpdatedAt?: string;
}

export interface WaitlistRecord {
  email: string;
  createdAt: string;
  sourceIp?: string;
  userAgent?: string;
}

export interface MessageRecord {
  sessionId: string;
  sk: string;
  messageId: string;
  role: "milo" | "user" | "system";
  text: string;
  timestamp: string;
  source: "passive_stuck" | "active_voice" | "active_text" | "context" | "system" | "active" | "passive";
}

export interface ConfigRecord {
  configKey: string;
  value: unknown;
}

export async function putSession(record: SessionRecord): Promise<void> {
  const client = getDocumentClient();
  await client.send(new PutCommand({ TableName: TABLE_SESSIONS, Item: record }));
}

export async function getSession(userId: string, sessionId: string): Promise<SessionRecord | undefined> {
  const client = getDocumentClient();
  const result = await client.send(
    new GetCommand({ TableName: TABLE_SESSIONS, Key: { userId, sessionId } })
  );
  return result.Item as SessionRecord | undefined;
}

export async function updateSessionContext(
  userId: string,
  sessionId: string,
  context: string
): Promise<void> {
  const client = getDocumentClient();
  const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  await client.send(
    new UpdateCommand({
      TableName: TABLE_SESSIONS,
      Key: { userId, sessionId },
      UpdateExpression: "SET #ctx = :ctx, #ctxAt = :ctxAt",
      ExpressionAttributeNames: {
        "#ctx": "context",
        "#ctxAt": "contextUpdatedAt",
      },
      ExpressionAttributeValues: {
        ":ctx": context,
        ":ctxAt": new Date().toISOString(),
      },
    })
  );
}

export async function updateSessionAnalysis(
  userId: string,
  sessionId: string,
  analysis: string
): Promise<void> {
  const client = getDocumentClient();
  const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  await client.send(
    new UpdateCommand({
      TableName: TABLE_SESSIONS,
      Key: { userId, sessionId },
      UpdateExpression: "SET #an = :an, #anAt = :anAt",
      ExpressionAttributeNames: {
        "#an": "currentAnalysis",
        "#anAt": "analysisUpdatedAt",
      },
      ExpressionAttributeValues: {
        ":an": analysis,
        ":anAt": new Date().toISOString(),
      },
    })
  );
}

export async function listSessions(userId: string): Promise<SessionRecord[]> {
  const client = getDocumentClient();
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_SESSIONS,
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: { ":uid": userId },
      ScanIndexForward: false,
    })
  );
  return (result.Items ?? []) as SessionRecord[];
}

export async function putWaitlist(record: WaitlistRecord): Promise<void> {
  const client = getDocumentClient();
  await client.send(
    new PutCommand({
      TableName: TABLE_WAITLIST,
      Item: record,
      ConditionExpression: "attribute_not_exists(email)",
    })
  );
}

export async function putMessage(record: MessageRecord): Promise<void> {
  const client = getDocumentClient();
  await client.send(new PutCommand({ TableName: TABLE_MESSAGES, Item: record }));
}

export async function listMessages(sessionId: string): Promise<MessageRecord[]> {
  const client = getDocumentClient();
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_MESSAGES,
      KeyConditionExpression: "sessionId = :sid",
      ExpressionAttributeValues: { ":sid": sessionId },
      ScanIndexForward: true,
    })
  );
  return (result.Items ?? []) as MessageRecord[];
}

export async function getConfig(configKey: string): Promise<ConfigRecord | undefined> {
  const client = getDocumentClient();
  const result = await client.send(
    new GetCommand({ TableName: TABLE_CONFIG, Key: { configKey } })
  );
  return result.Item as ConfigRecord | undefined;
}
