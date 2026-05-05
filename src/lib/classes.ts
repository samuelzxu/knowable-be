// Class CRUD + student class-join helpers.
// See .omc/design/educator-tools/02-architecture.md §2.
//
// Tables:
//   - knowable-classes (PK = SK = classId; GSI `code-index` on `code`)
//   - knowable-class-members (PK = classId, SK = studentUserId;
//     GSI `student-index` on `studentUserId`)

import { randomBytes, randomUUID } from "node:crypto";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  getDocumentClient,
  TABLE_CLASSES,
  TABLE_CLASS_MEMBERS,
} from "./dynamo.js";

// Codes are 6 uppercase alphanumeric chars excluding I/O/0/1 to remove
// look-alikes. 32^6 = ~1.07B combinations — collision probability is
// negligible at v0 scale; we still retry on collision in `createClass`.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const CODE_TTL_DAYS = 90;
const MAX_CODE_RETRIES = 5;

export interface Class {
  classId: string;
  educatorId: string;
  name: string;
  code: string;
  createdAt: string;
  codeExpiresAt: string;
}

export interface ClassMember {
  classId: string;
  studentUserId: string;
  joinedAt: string;
  displayName: string;
  sharingTier: "off" | "stats" | "stats+activity";
}

export interface JoinResult {
  classId: string;
  className: string;
  educatorDisplayName: string;
  /** Always `"off"` on a fresh join — the student opts up to higher tiers
   *  via the macOS Settings segmented control. Included here so the
   *  client's `ClassMembership` decoder doesn't need a separate fetch
   *  immediately after join. */
  sharingTier: "off" | "stats" | "stats+activity";
}

export interface Membership {
  classId: string;
  studentUserId: string;
  joinedAt: string;
  displayName: string;
  sharingTier: "off" | "stats" | "stats+activity";
}

/**
 * Generates a 6-char uppercase alphanumeric code with ambiguous chars
 * (I, O, 0, 1) excluded.
 */
export function generateClassCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    const b = bytes[i] ?? 0;
    const idx = b % CODE_ALPHABET.length;
    code += CODE_ALPHABET[idx];
  }
  return code;
}

async function codeIsTaken(code: string): Promise<boolean> {
  const client = getDocumentClient();
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_CLASSES,
      IndexName: "code-index",
      KeyConditionExpression: "code = :c",
      ExpressionAttributeValues: { ":c": code },
      Limit: 1,
    })
  );
  return (result.Items?.length ?? 0) > 0;
}

/**
 * Creates a class for the given educator. Generates a unique 6-char code
 * (retrying on the rare GSI collision) and persists the class row.
 */
export async function createClass(educatorId: string, name: string): Promise<Class> {
  let code = generateClassCode();
  for (let attempt = 0; attempt < MAX_CODE_RETRIES; attempt++) {
    if (!(await codeIsTaken(code))) break;
    code = generateClassCode();
    if (attempt === MAX_CODE_RETRIES - 1) {
      throw new Error("class_code_collision_exhausted");
    }
  }

  const classId = randomUUID();
  const createdAt = new Date();
  const codeExpiresAt = new Date(createdAt.getTime() + CODE_TTL_DAYS * 86400 * 1000);

  const item: Class = {
    classId,
    educatorId,
    name,
    code,
    createdAt: createdAt.toISOString(),
    codeExpiresAt: codeExpiresAt.toISOString(),
  };

  const client = getDocumentClient();
  await client.send(
    new PutCommand({
      TableName: TABLE_CLASSES,
      // PK = SK = classId per dynamodb.tf — both must be present on the item.
      Item: item,
    })
  );
  return item;
}

/**
 * Lists every class owned by the educator. v0 implementation: full table Scan
 * with a filter expression. Acceptable while educators are < 100s; switch to
 * an `educatorId-index` GSI when this becomes a hot path.
 */
export async function listClasses(educatorId: string): Promise<Class[]> {
  const client = getDocumentClient();
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_CLASSES,
      FilterExpression: "educatorId = :eid",
      ExpressionAttributeValues: { ":eid": educatorId },
    })
  );
  return (result.Items ?? []) as Class[];
}

export async function getClass(classId: string): Promise<Class | undefined> {
  const client = getDocumentClient();
  // Table is keyed PK = SK = classId (single-item-per-class pattern from
  // dynamodb.tf). DocumentClient handles the duplicate key value fine —
  // we pass `classId` once because the marshaller fills in both attrs.
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_CLASSES,
      Key: { classId },
    })
  );
  return result.Item as Class | undefined;
}

async function listMembers(classId: string): Promise<ClassMember[]> {
  const client = getDocumentClient();
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_CLASS_MEMBERS,
      KeyConditionExpression: "classId = :cid",
      ExpressionAttributeValues: { ":cid": classId },
    })
  );
  return (result.Items ?? []) as ClassMember[];
}

export async function getClassWithMembers(
  classId: string
): Promise<{ class: Class; members: ClassMember[] } | null> {
  const cls = await getClass(classId);
  if (!cls) return null;
  const members = await listMembers(classId);
  return { class: cls, members };
}

export class JoinError extends Error {
  constructor(
    public code:
      | "class_not_found"
      | "code_expired"
      | "already_in_class"
      | "educators_cannot_join",
    public extra?: Record<string, unknown>
  ) {
    super(code);
    this.name = "JoinError";
  }
}

/**
 * Looks up the student's existing class membership via the `student-index`
 * GSI. Returns null if the student is in no class.
 */
export async function getStudentMembership(
  studentUserId: string
): Promise<Membership | null> {
  const client = getDocumentClient();
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_CLASS_MEMBERS,
      IndexName: "student-index",
      KeyConditionExpression: "studentUserId = :sid",
      ExpressionAttributeValues: { ":sid": studentUserId },
      Limit: 1,
    })
  );
  const item = (result.Items ?? [])[0] as Membership | undefined;
  return item ?? null;
}

/**
 * Joins a student to a class identified by code. Enforces the §2 error
 * matrix: not-found, expired, already-in-class (idempotent if same class,
 * 409 if different), educator-self-join.
 */
export async function joinClass(
  studentUserId: string,
  code: string,
  displayName: string
): Promise<JoinResult> {
  const client = getDocumentClient();

  // 1. Resolve code -> class
  const codeQuery = await client.send(
    new QueryCommand({
      TableName: TABLE_CLASSES,
      IndexName: "code-index",
      KeyConditionExpression: "code = :c",
      ExpressionAttributeValues: { ":c": code },
      Limit: 1,
    })
  );
  const cls = (codeQuery.Items ?? [])[0] as Class | undefined;
  if (!cls) throw new JoinError("class_not_found");

  // 2. Expiry check
  if (cls.codeExpiresAt && new Date(cls.codeExpiresAt).getTime() < Date.now()) {
    throw new JoinError("code_expired");
  }

  // 3. Educator joining own class is a footgun — block it.
  if (cls.educatorId === studentUserId) {
    throw new JoinError("educators_cannot_join");
  }

  // 4. Already-in-class check
  const existing = await getStudentMembership(studentUserId);
  if (existing) {
    if (existing.classId === cls.classId) {
      // Idempotent — return existing membership.
      const educatorRow = await client.send(
        new GetCommand({
          TableName: process.env["DYNAMODB_TABLE_ROLES"] ?? "knowable-roles",
          Key: { userId: cls.educatorId, role: "educator" },
        })
      );
      const educatorDisplayName =
        (educatorRow.Item?.["displayName"] as string | undefined) ?? "";
      return {
        classId: cls.classId,
        className: cls.name,
        educatorDisplayName,
        sharingTier: existing.sharingTier,
      };
    }
    // Different class — caller must leave first.
    const otherClassQuery = await client.send(
      new GetCommand({
        TableName: TABLE_CLASSES,
        Key: { classId: existing.classId },
      })
    );
    const otherName =
      (otherClassQuery.Item?.["name"] as string | undefined) ?? existing.classId;
    throw new JoinError("already_in_class", { currentClass: otherName });
  }

  // 5. Insert membership
  const member: ClassMember = {
    classId: cls.classId,
    studentUserId,
    joinedAt: new Date().toISOString(),
    displayName,
    sharingTier: "off",
  };
  await client.send(
    new PutCommand({
      TableName: TABLE_CLASS_MEMBERS,
      Item: member,
    })
  );

  // 6. Look up educator display name for the response payload
  const educatorRow = await client.send(
    new GetCommand({
      TableName: process.env["DYNAMODB_TABLE_ROLES"] ?? "knowable-roles",
      Key: { userId: cls.educatorId, role: "educator" },
    })
  );
  const educatorDisplayName =
    (educatorRow.Item?.["displayName"] as string | undefined) ?? "";

  return {
    classId: cls.classId,
    className: cls.name,
    educatorDisplayName,
    sharingTier: "off",
  };
}

/**
 * Removes a student from a class. No-op if the student is not a member.
 */
export async function leaveClass(
  classId: string,
  studentUserId: string
): Promise<void> {
  const client = getDocumentClient();
  await client.send(
    new DeleteCommand({
      TableName: TABLE_CLASS_MEMBERS,
      Key: { classId, studentUserId },
    })
  );
}
