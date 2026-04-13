import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_SESSIONS = process.env["DYNAMODB_TABLE_SESSIONS"] ?? "knowable-sessions";
const TABLE_PROBLEMS = process.env["DYNAMODB_TABLE_PROBLEMS"] ?? "knowable-problems";
const TABLE_HINTS = process.env["DYNAMODB_TABLE_HINTS"] ?? "knowable-hints";
const TABLE_GRADES = process.env["DYNAMODB_TABLE_GRADES"] ?? "knowable-grades";
const TABLE_WAITLIST = process.env["DYNAMODB_TABLE_WAITLIST"] ?? "knowable-waitlist";
const TABLE_TELEMETRY = process.env["DYNAMODB_TABLE_TELEMETRY"] ?? "knowable-telemetry";
const TABLE_CONFIG = process.env["DYNAMODB_TABLE_CONFIG"] ?? "knowable-config";

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
}

export interface ProblemRecord {
  sessionId: string;
  problemId: string;
  text: string;
  startedAt: string;
  endedAt?: string;
  hintsCount?: number;
}

export interface HintRecord {
  problemId: string;
  hintId: string;
  text: string;
  deliveredAt: string;
  source: string;
  tokensIn?: number;
  tokensOut?: number;
}

export interface GradeRecord {
  userId: string;
  gradeId: string;
  subject: string;
  score: number;
  loggedAt: string;
}

export interface WaitlistRecord {
  email: string;
  createdAt: string;
  sourceIp?: string;
  userAgent?: string;
}

export interface TelemetryRecord {
  userId: string;
  ts: string;
  eventType: string;
  payload: Record<string, unknown>;
  ttl?: number;
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

export async function putProblem(record: ProblemRecord): Promise<void> {
  const client = getDocumentClient();
  await client.send(new PutCommand({ TableName: TABLE_PROBLEMS, Item: record }));
}

export async function putHint(record: HintRecord): Promise<void> {
  const client = getDocumentClient();
  await client.send(new PutCommand({ TableName: TABLE_HINTS, Item: record }));
}

export async function putGrade(record: GradeRecord): Promise<void> {
  const client = getDocumentClient();
  await client.send(new PutCommand({ TableName: TABLE_GRADES, Item: record }));
}

export async function listGrades(userId: string): Promise<GradeRecord[]> {
  const client = getDocumentClient();
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_GRADES,
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: { ":uid": userId },
      ScanIndexForward: false,
    })
  );
  return (result.Items ?? []) as GradeRecord[];
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

export async function putTelemetryEvent(record: TelemetryRecord): Promise<void> {
  const client = getDocumentClient();
  await client.send(new PutCommand({ TableName: TABLE_TELEMETRY, Item: record }));
}

export async function getConfig(configKey: string): Promise<ConfigRecord | undefined> {
  const client = getDocumentClient();
  const result = await client.send(
    new GetCommand({ TableName: TABLE_CONFIG, Key: { configKey } })
  );
  return result.Item as ConfigRecord | undefined;
}
