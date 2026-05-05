// Educator role lookup and registration.
// See .omc/design/educator-tools/02-architecture.md §1.
//
// Students are *implicit*: a Cognito user with no row in `knowable-roles` is
// treated as a student. Only educators have a row, keyed by (userId, "educator").

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, TABLE_ROLES } from "./dynamo.js";

export interface EducatorRole {
  userId: string;
  role: "educator";
  email: string;
  displayName: string;
  createdAt: string;
}

/**
 * Returns true if the given Cognito sub has an educator row in `knowable-roles`.
 * ~5ms DynamoDB GetItem; safe to call once per educator-gated request.
 */
export async function isEducator(userId: string): Promise<boolean> {
  const client = getDocumentClient();
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_ROLES,
      Key: { userId, role: "educator" },
    })
  );
  return !!result.Item;
}

/**
 * Idempotently registers an educator. Re-registering the same user simply
 * overwrites the existing row (e.g., display-name updates).
 */
export async function registerEducator(
  userId: string,
  email: string,
  displayName: string
): Promise<void> {
  const client = getDocumentClient();
  const item: EducatorRole = {
    userId,
    role: "educator",
    email,
    displayName,
    createdAt: new Date().toISOString(),
  };
  await client.send(
    new PutCommand({
      TableName: TABLE_ROLES,
      Item: item,
    })
  );
}
