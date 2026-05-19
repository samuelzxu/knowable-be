import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  BatchWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE_SESSIONS = process.env["DYNAMODB_TABLE_SESSIONS"] ?? "knowable-sessions";
const TABLE_SESSION_EVENTS = process.env["DYNAMODB_TABLE_SESSION_EVENTS"] ?? "knowable-session-events";
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
  // Lifecycle state surfaced from the client's CDSession.
  // `status` is one of "active" | "paused" | "ended" — `nil` on legacy
  // rows is read as "active" by clients.
  status?: "active" | "paused" | "ended";
  pausedAt?: string;
  // Snapshot of the latest reasoning-loop `currentAnalysis` at pause
  // time. Used by the client's Dashboard resume CTA and by Bedrock
  // analysis for the "where the session left off" prompt block.
  lastUnderstanding?: string;
}

/// One row per timeline event. PK = sessionId so each session lives in
/// its own partition; SK = `${ts13}#${uuid}` for chronological order
/// with collision-free concurrent writes. `ttl` is epoch-seconds and
/// expires the row ~1 year after creation (set by the writer).
export interface SessionEventRecord {
  sessionId: string;
  sk: string;
  userId: string;
  type: string;
  timestampMs: number;
  payload?: Record<string, unknown>;
  ttl: number;
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
  // Set by `updateMessageText` when the student edits one of their own
  // bubbles. Absent on never-edited rows. The chat view shows the
  // current `text`; the session-event stream remains the historical
  // record of what was originally said in the moment.
  editedAt?: string;
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

/// Paginated message list. DynamoDB's Query returns up to 1MB of items
/// per call; on a chat-heavy session that can be exceeded, and the
/// previous unpaginated implementation silently dropped everything past
/// the first page. Callers pass `after` (the previous response's
/// `nextCursor`, the `sk` of the last item) to continue.
export async function listMessages(
  sessionId: string,
  opts: { limit?: number; after?: string } = {}
): Promise<{ messages: MessageRecord[]; nextCursor: string | null }> {
  const client = getDocumentClient();
  const limit = opts.limit ?? 500;
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_MESSAGES,
      KeyConditionExpression: "sessionId = :sid",
      ExpressionAttributeValues: { ":sid": sessionId },
      ScanIndexForward: true,
      Limit: limit,
      ExclusiveStartKey: opts.after
        ? { sessionId, sk: opts.after }
        : undefined,
    })
  );
  const messages = (result.Items ?? []) as MessageRecord[];
  // LastEvaluatedKey is set when DDB stopped early — either at the
  // page-size limit or at the 1MB boundary. The client should poll
  // again with `after = nextCursor` to drain the remainder.
  const nextCursor =
    result.LastEvaluatedKey?.["sk"] != null
      ? (result.LastEvaluatedKey["sk"] as string)
      : null;
  return { messages, nextCursor };
}

/// Edit the text of an existing user-authored message. Conditional on
/// `role == "user"` so the route layer doesn't need a separate Get
/// roundtrip — Milo's hints and system messages atomically fail the
/// condition and the SDK throws ConditionalCheckFailedException, which
/// the caller maps to 403. Idempotent for the same `(sessionId, sk,
/// text)` triplet because UpdateItem is a SET, not an append.
export async function updateMessageText(
  sessionId: string,
  sk: string,
  text: string
): Promise<MessageRecord> {
  const client = getDocumentClient();
  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_MESSAGES,
      Key: { sessionId, sk },
      UpdateExpression: "SET #t = :t, editedAt = :now",
      ConditionExpression: "#role = :userRole",
      ExpressionAttributeNames: { "#t": "text", "#role": "role" },
      ExpressionAttributeValues: {
        ":t": text,
        ":now": new Date().toISOString(),
        ":userRole": "user",
      },
      ReturnValues: "ALL_NEW",
    })
  );
  return result.Attributes as MessageRecord;
}

/// Append a batch of trace events (up to 25 per DynamoDB BatchWriteItem
/// limit). Callers should chunk larger batches client-side. Returns the
/// list of unprocessed items so the caller can retry — DDB may throttle
/// individual writes under burst load and we want the writer queue to
/// see partial failures distinctly from network errors.
export async function putSessionEventBatch(
  records: SessionEventRecord[]
): Promise<SessionEventRecord[]> {
  if (records.length === 0) return [];
  if (records.length > 25) {
    throw new Error(`putSessionEventBatch: max 25 items, got ${records.length}`);
  }
  const client = getDocumentClient();
  const result = await client.send(
    new BatchWriteCommand({
      RequestItems: {
        [TABLE_SESSION_EVENTS]: records.map((r) => ({ PutRequest: { Item: r } })),
      },
    })
  );
  const unprocessed = result.UnprocessedItems?.[TABLE_SESSION_EVENTS] ?? [];
  return unprocessed.map((u) => u.PutRequest!.Item as SessionEventRecord);
}

/// Paginated session-event timeline read. PK is sessionId; ownership is
/// validated by the route layer via a Get on knowable-sessions for
/// (req.userId, sessionId) before this is called. Returns events in
/// chronological order — the SK encodes timestampMs so ScanIndexForward
/// = true is the natural sort.
export async function listSessionEvents(
  sessionId: string,
  opts: { limit?: number; after?: string } = {}
): Promise<{ events: SessionEventRecord[]; nextCursor: string | null }> {
  const client = getDocumentClient();
  const limit = opts.limit ?? 500;
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_SESSION_EVENTS,
      KeyConditionExpression: "sessionId = :sid",
      ExpressionAttributeValues: { ":sid": sessionId },
      ScanIndexForward: true,
      Limit: limit,
      ExclusiveStartKey: opts.after
        ? { sessionId, sk: opts.after }
        : undefined,
    })
  );
  const events = (result.Items ?? []) as SessionEventRecord[];
  const nextCursor =
    result.LastEvaluatedKey?.["sk"] != null
      ? (result.LastEvaluatedKey["sk"] as string)
      : null;
  return { events, nextCursor };
}

export async function getConfig(configKey: string): Promise<ConfigRecord | undefined> {
  const client = getDocumentClient();
  const result = await client.send(
    new GetCommand({ TableName: TABLE_CONFIG, Key: { configKey } })
  );
  return result.Item as ConfigRecord | undefined;
}
