/**
 * scripts/create-invite.ts
 * ------------------------
 * Admin CLI for minting a new educator invite code.
 *
 * Usage:
 *   npm run create-invite
 *   npm run create-invite -- --max-uses 5 --expires-in 30d --note "Pilot teacher cohort"
 *
 * Or via env vars:
 *   INVITE_MAX_USES=5 INVITE_EXPIRES_IN_DAYS=30 INVITE_NOTE="Pilot teacher cohort" npm run create-invite
 *
 * Defaults:
 *   max-uses = 5
 *   expires  = never
 *   note     = (none)
 *
 * Writes one row to `knowable-educator-invites` with `usedCount=0` and
 * prints the hyphenated display form for the operator to share.
 */

import { randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

// ---- Local copies of invite primitives ------------------------------------
//
// Mirrors src/lib/invites.ts. We duplicate rather than import because the
// scripts tsconfig has its own resolution settings and we want the script
// to run standalone via `tsx` with no build step.

const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INVITE_LENGTH = 16;

function generateInviteCode(): string {
  const bytes = randomBytes(INVITE_LENGTH);
  let code = "";
  for (let i = 0; i < INVITE_LENGTH; i++) {
    const b = bytes[i] ?? 0;
    code += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
  }
  return code;
}

function formatInviteForDisplay(code: string): string {
  return (
    code.slice(0, 4) +
    "-" +
    code.slice(4, 8) +
    "-" +
    code.slice(8, 12) +
    "-" +
    code.slice(12, 16)
  );
}

// ---- Arg parsing -----------------------------------------------------------

interface InviteArgs {
  maxUses: number;
  expiresInDays: number | null;
  note: string | null;
}

function parseArgs(argv: string[]): InviteArgs {
  let maxUses = parseInt(process.env["INVITE_MAX_USES"] ?? "5", 10);
  let expiresInDays: number | null = process.env["INVITE_EXPIRES_IN_DAYS"]
    ? parseInt(process.env["INVITE_EXPIRES_IN_DAYS"], 10)
    : null;
  let note: string | null = process.env["INVITE_NOTE"] ?? null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-uses") {
      const next = argv[i + 1];
      if (!next) throw new Error("--max-uses requires a value");
      maxUses = parseInt(next, 10);
      i++;
    } else if (a === "--expires-in") {
      // Accept "30d" or plain number of days
      const next = argv[i + 1];
      if (!next) throw new Error("--expires-in requires a value");
      const m = next.match(/^(\d+)d?$/);
      if (!m || m[1] === undefined) {
        throw new Error(`--expires-in: expected e.g. "30d", got "${next}"`);
      }
      expiresInDays = parseInt(m[1], 10);
      i++;
    } else if (a === "--note") {
      const next = argv[i + 1];
      if (!next) throw new Error("--note requires a value");
      note = next;
      i++;
    }
  }

  if (!Number.isFinite(maxUses) || maxUses < 1) {
    throw new Error(`Invalid --max-uses: ${maxUses}`);
  }
  if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays < 1)) {
    throw new Error(`Invalid --expires-in days: ${expiresInDays}`);
  }
  return { maxUses, expiresInDays, note };
}

// ---- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const tableName =
    process.env["DYNAMODB_TABLE_EDUCATOR_INVITES"] ?? "knowable-educator-invites";

  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region }),
    { marshallOptions: { removeUndefinedValues: true } }
  );

  const code = generateInviteCode();
  const createdAt = new Date();
  const expiresAt =
    args.expiresInDays !== null
      ? new Date(createdAt.getTime() + args.expiresInDays * 86_400 * 1000).toISOString()
      : null;

  const item: Record<string, unknown> = {
    code,
    maxUses: args.maxUses,
    usedCount: 0,
    createdAt: createdAt.toISOString(),
  };
  if (expiresAt) item["expiresAt"] = expiresAt;
  if (args.note) item["note"] = args.note;

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    })
  );

  const display = formatInviteForDisplay(code);
  console.log("=== Educator invite created ===");
  console.log(`  code:        ${display}`);
  console.log(`  max uses:    ${args.maxUses}`);
  console.log(`  expires at:  ${expiresAt ?? "never"}`);
  console.log(`  note:        ${args.note ?? "(none)"}`);
  console.log("");
  console.log("Share the hyphenated code above. Either form (with or without");
  console.log("hyphens, any case) is accepted at signup.");
}

main().catch((err) => {
  console.error("create-invite failed:", err);
  process.exitCode = 1;
});
