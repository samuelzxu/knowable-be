// Lambda entry point for student → backend share uploads.
// See .omc/design/educator-tools/02-architecture.md §3.
//
// Two routes — both require an authenticated student who is a member of the
// target classId:
//
//   POST /classes/{classId}/share-stats  — Stats-only tier upload
//   POST /classes/{classId}/share-trace  — Stats+Activity per-session trace
//
// All payloads are validated against the `.strict()` Zod schemas in
// share-schemas.ts. Anything outside the whitelist is rejected with 400 and
// the Zod error issues are returned so the client can debug.

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { verifyJwt, extractBearerToken } from "../lib/auth.js";
import {
  getDocumentClient,
  TABLE_CLASS_MEMBERS,
  TABLE_SESSION_TRACES,
} from "../lib/dynamo.js";
import {
  ShareStatsSchema,
  ShareTraceSchema,
} from "../lib/share-schemas.js";

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function authenticate(event: APIGatewayProxyEventV2): Promise<string | null> {
  const token = extractBearerToken(event.headers?.["authorization"]);
  if (!token) return null;
  try {
    const claims = await verifyJwt(token);
    return claims.sub;
  } catch {
    return null;
  }
}

interface MembershipRow {
  classId: string;
  studentUserId: string;
  sharingTier?: "off" | "stats" | "stats+activity";
}

async function getMembership(
  classId: string,
  studentUserId: string
): Promise<MembershipRow | null> {
  const client = getDocumentClient();
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_CLASS_MEMBERS,
      Key: { classId, studentUserId },
    })
  );
  return (result.Item as MembershipRow | undefined) ?? null;
}

const SHARING_TIER_RANK: Record<"off" | "stats" | "stats+activity", number> = {
  off: 0,
  stats: 1,
  "stats+activity": 2,
};

/**
 * Returns the tier to write back, given the existing tier and the minimum
 * tier the current upload requires. Never downgrades.
 */
function bumpTier(
  current: "off" | "stats" | "stats+activity" | undefined,
  minimum: "stats" | "stats+activity"
): "off" | "stats" | "stats+activity" {
  const cur = current ?? "off";
  if (SHARING_TIER_RANK[cur] >= SHARING_TIER_RANK[minimum]) return cur;
  return minimum;
}

const TRACE_TTL_DAYS = 90;

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const studentUserId = await authenticate(event);
  if (!studentUserId) return json(401, { error: "unauthorized" });

  const routeKey = event.routeKey ?? "";
  const pathParams = event.pathParameters ?? {};
  const classId = pathParams["classId"];
  if (!classId) return json(400, { error: "missing_class_id" });

  let body: unknown;
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch {
      return json(400, { error: "invalid_json" });
    }
  } else {
    return json(400, { error: "missing_body" });
  }

  // Membership check is identical for both routes.
  const membership = await getMembership(classId, studentUserId);
  if (!membership) return json(403, { error: "not_a_member" });

  const client = getDocumentClient();
  const now = new Date();

  // ---- POST /classes/{classId}/share-stats ----
  if (routeKey === "POST /classes/{classId}/share-stats") {
    const parsed = ShareStatsSchema.safeParse(body);
    if (!parsed.success) {
      return json(400, { error: "invalid_body", issues: parsed.error.issues });
    }
    const newTier = bumpTier(membership.sharingTier, "stats");
    await client.send(
      new UpdateCommand({
        TableName: TABLE_CLASS_MEMBERS,
        Key: { classId, studentUserId },
        UpdateExpression:
          "SET latestStats = :s, latestStatsAt = :sAt, sharingTier = :t",
        ExpressionAttributeValues: {
          ":s": parsed.data,
          ":sAt": now.toISOString(),
          ":t": newTier,
        },
      })
    );
    return json(200, { ok: true, sharingTier: newTier });
  }

  // ---- POST /classes/{classId}/share-trace ----
  if (routeKey === "POST /classes/{classId}/share-trace") {
    const parsed = ShareTraceSchema.safeParse(body);
    if (!parsed.success) {
      return json(400, { error: "invalid_body", issues: parsed.error.issues });
    }
    const trace = parsed.data;

    // TTL = 90 days from now (epoch seconds for DDB TTL semantics).
    const ttl = Math.floor(now.getTime() / 1000) + TRACE_TTL_DAYS * 86_400;

    await client.send(
      new PutCommand({
        TableName: TABLE_SESSION_TRACES,
        Item: {
          studentUserId,
          sessionId: trace.sessionId,
          classId,
          startedAt: trace.startedAt,
          endedAt: trace.endedAt,
          events: trace.events,
          understandings: trace.understandings,
          hints: trace.hints,
          ttl,
        },
      })
    );

    const newTier = bumpTier(membership.sharingTier, "stats+activity");
    if (newTier !== membership.sharingTier) {
      await client.send(
        new UpdateCommand({
          TableName: TABLE_CLASS_MEMBERS,
          Key: { classId, studentUserId },
          UpdateExpression: "SET sharingTier = :t",
          ExpressionAttributeValues: { ":t": newTier },
        })
      );
    }

    return json(200, { ok: true, sharingTier: newTier });
  }

  return json(405, { error: "method_not_allowed", routeKey });
};
