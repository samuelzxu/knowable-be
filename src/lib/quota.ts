import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const TABLE_QUOTA = process.env["DYNAMODB_TABLE_QUOTA"] ?? "knowable-quota";
const DAILY_HINT_QUOTA_PER_USER = parseInt(
  process.env["DAILY_HINT_QUOTA_PER_USER"] ?? "30",
  10
);
const DAILY_HINT_QUOTA_GLOBAL = parseInt(
  process.env["DAILY_HINT_QUOTA_GLOBAL"] ?? "500",
  10
);

let _client: DynamoDBClient | null = null;

function getDynamoClient(): DynamoDBClient {
  if (!_client) {
    _client = new DynamoDBClient({ region: process.env["AWS_REGION"] ?? "us-east-1" });
  }
  return _client;
}

function getTodayYYYYMMDD(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

export type QuotaFailureReason = "user_quota" | "global_ceiling";

export type QuotaResult =
  | { ok: true }
  | { ok: false; reason: QuotaFailureReason };

export async function checkAndIncrementUserDailyQuota(
  userId: string
): Promise<QuotaResult> {
  const client = getDynamoClient();
  const sk = getTodayYYYYMMDD();

  try {
    await client.send(
      new UpdateItemCommand({
        TableName: TABLE_QUOTA,
        Key: {
          userId: { S: userId },
          yyyymmdd: { S: sk },
        },
        UpdateExpression:
          "SET #count = if_not_exists(#count, :zero) + :one",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :cap",
        ExpressionAttributeNames: {
          "#count": "count",
        },
        ExpressionAttributeValues: {
          ":zero": { N: "0" },
          ":one": { N: "1" },
          ":cap": { N: String(DAILY_HINT_QUOTA_PER_USER) },
        },
      })
    );
    return { ok: true };
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error.name === "ConditionalCheckFailedException") {
      return { ok: false, reason: "user_quota" };
    }
    throw err;
  }
}

export async function checkAndIncrementGlobalDailyQuota(): Promise<QuotaResult> {
  const client = getDynamoClient();
  const sk = getTodayYYYYMMDD();
  const globalPk = "knowable-quota#GLOBAL";

  try {
    await client.send(
      new UpdateItemCommand({
        TableName: TABLE_QUOTA,
        Key: {
          userId: { S: globalPk },
          yyyymmdd: { S: sk },
        },
        UpdateExpression:
          "SET #count = if_not_exists(#count, :zero) + :one",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :cap",
        ExpressionAttributeNames: {
          "#count": "count",
        },
        ExpressionAttributeValues: {
          ":zero": { N: "0" },
          ":one": { N: "1" },
          ":cap": { N: String(DAILY_HINT_QUOTA_GLOBAL) },
        },
      })
    );
    return { ok: true };
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error.name === "ConditionalCheckFailedException") {
      return { ok: false, reason: "global_ceiling" };
    }
    throw err;
  }
}
