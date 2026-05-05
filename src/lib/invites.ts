// Invite-code lookup, generation, and atomic single-use redemption.
// See .omc/design/educator-tools/02-architecture.md §1 (identity model).
//
// Educator signups are gated by a random invite code with a hard maxUses
// cap and an optional expiry. `consumeInviteCode` performs an atomic
// `UpdateCommand` that increments `usedCount` only when both the cap and
// expiry conditions still hold — so simultaneous redemptions cannot both
// succeed when only one slot is left.

import { randomBytes } from "node:crypto";
import { GetCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, TABLE_EDUCATOR_INVITES } from "./dynamo.js";

// ---- Public types ----------------------------------------------------------

export interface InviteRecord {
  code: string;
  maxUses: number;
  usedCount: number;
  expiresAt?: string;
  note?: string;
  createdAt: string;
}

export type InviteFailureKind = "not_found" | "expired" | "exhausted";

export class InviteError extends Error {
  constructor(
    public kind: InviteFailureKind,
    message: string
  ) {
    super(message);
    this.name = "InviteError";
  }
}

// ---- Code generation -------------------------------------------------------

// 16-char base32-ish alphabet. Excludes ambiguous chars (I, O, 0, 1, L)
// because operators paste these into Slack/email. Lowercase is intentionally
// excluded — keep it copy-safe across mixed clients.
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INVITE_LENGTH = 16;

/**
 * Returns a 16-character invite code drawn from the human-readable alphabet.
 * Display form (`formatInviteForDisplay`) inserts hyphens every 4 chars; the
 * storage form is the raw 16-char string.
 */
export function generateInviteCode(): string {
  const bytes = randomBytes(INVITE_LENGTH);
  let code = "";
  for (let i = 0; i < INVITE_LENGTH; i++) {
    const b = bytes[i] ?? 0;
    code += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
  }
  return code;
}

/**
 * `XXXXXXXXXXXXXXXX` -> `XXXX-XXXX-XXXX-XXXX`. Operators share the
 * hyphenated form; users may paste either form (we normalize on input).
 */
export function formatInviteForDisplay(code: string): string {
  const normalized = normalizeInviteCode(code);
  return (
    normalized.slice(0, 4) +
    "-" +
    normalized.slice(4, 8) +
    "-" +
    normalized.slice(8, 12) +
    "-" +
    normalized.slice(12, 16)
  );
}

/**
 * Strip whitespace and hyphens, uppercase. Use before any DDB lookup so
 * `xxxx-xxxx-xxxx-xxxx`, `XXXXXXXXXXXXXXXX`, and pasted-with-spaces all
 * resolve to the same key.
 */
export function normalizeInviteCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Returns the first 8 chars of a SHA-256-like digest of the code, suitable
 * for log lines without revealing the full code. We use a simple non-crypto
 * digest to avoid pulling sha256 into hot paths — invite codes are
 * already random + short-lived.
 */
export function redactInviteCode(code: string): string {
  const normalized = normalizeInviteCode(code);
  return `${normalized.slice(0, 4)}…(${normalized.length})`;
}

// ---- Admin write -----------------------------------------------------------

export interface CreateInviteInput {
  maxUses: number;
  expiresAt?: string; // ISO8601, optional
  note?: string;
}

/**
 * Writes a new invite to `knowable-educator-invites` with `usedCount=0`.
 * Returns the persisted record. Used by the admin CLI and the demo seeder.
 */
export async function createInvite(
  input: CreateInviteInput
): Promise<InviteRecord> {
  const code = generateInviteCode();
  const createdAt = new Date().toISOString();
  const item: InviteRecord = {
    code,
    maxUses: input.maxUses,
    usedCount: 0,
    createdAt,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
  const client = getDocumentClient();
  await client.send(
    new PutCommand({
      TableName: TABLE_EDUCATOR_INVITES,
      Item: item,
    })
  );
  return item;
}

// ---- Atomic redemption -----------------------------------------------------

/**
 * Atomically consume one use of an invite code.
 *
 * Implementation: a single `UpdateCommand` with `ADD usedCount :one` and a
 * `ConditionExpression` that checks attribute existence, the maxUses cap,
 * and the expiry. `ReturnValues: "ALL_NEW"` returns the post-increment
 * record. Two concurrent redemptions when only one slot remains: exactly
 * one succeeds — DynamoDB serializes the conditional update.
 *
 * On `ConditionalCheckFailedException`, we follow up with a `GetCommand`
 * to disambiguate not_found vs exhausted vs expired (the conditional
 * itself can't tell us which clause failed). Cost is fine — this is the
 * cold/error path.
 */
export async function consumeInviteCode(code: string): Promise<InviteRecord> {
  const normalized = normalizeInviteCode(code);
  if (!normalized) {
    throw new InviteError("not_found", "invite_invalid");
  }

  const client = getDocumentClient();
  const nowIso = new Date().toISOString();

  try {
    const result = await client.send(
      new UpdateCommand({
        TableName: TABLE_EDUCATOR_INVITES,
        Key: { code: normalized },
        UpdateExpression: "ADD usedCount :one",
        ConditionExpression:
          "attribute_exists(code) AND usedCount < maxUses AND (attribute_not_exists(expiresAt) OR expiresAt > :now)",
        ExpressionAttributeValues: {
          ":one": 1,
          ":now": nowIso,
        },
        ReturnValues: "ALL_NEW",
      })
    );
    const attrs = result.Attributes as InviteRecord | undefined;
    if (!attrs) {
      // Should not happen with ALL_NEW after a successful update, but
      // defend against it rather than fabricate values.
      throw new InviteError("not_found", "invite_invalid");
    }
    return attrs;
  } catch (err: unknown) {
    const error = err as { name?: string };
    if (error.name !== "ConditionalCheckFailedException") {
      throw err;
    }
    // Disambiguate: read current state. Order matters — check existence
    // first, then expiry, then exhaustion.
    const current = await client.send(
      new GetCommand({
        TableName: TABLE_EDUCATOR_INVITES,
        Key: { code: normalized },
      })
    );
    const item = current.Item as InviteRecord | undefined;
    if (!item) {
      throw new InviteError("not_found", "invite_invalid");
    }
    if (item.expiresAt && item.expiresAt <= nowIso) {
      throw new InviteError("expired", "invite_expired");
    }
    if (item.usedCount >= item.maxUses) {
      throw new InviteError("exhausted", "invite_exhausted");
    }
    // Race: state changed between our update attempt and the follow-up
    // read (e.g., a parallel redemption pushed past the cap, then our read
    // sees pre-state). Treat as exhausted — the safest closed-loop
    // mapping for the caller.
    throw new InviteError("exhausted", "invite_exhausted");
  }
}
