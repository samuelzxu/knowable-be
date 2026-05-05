/**
 * scripts/seed-demo.ts
 * --------------------
 * Idempotent demo-data seeder for the Kaggle video.
 *
 * Creates:
 *   1. A real Cognito educator account (UUID Username, email-as-alias) with a
 *      permanent password and a `knowable-roles` row.
 *   2. One `knowable-classes` row ("AP Calculus · Period 3 [SEED]").
 *   3. Five `knowable-class-members` rows (synthetic UUID studentUserIds —
 *      they are NOT real Cognito accounts; the dashboard only queries by
 *      userId).
 *   4. 10–14 `knowable-sessions` + matching `knowable-session-traces` per
 *      student over the last 14 days. Each student has a distinct behaviour
 *      pattern so Bedrock-Opus produces interesting cited insights.
 *
 * Idempotency: the script keys off the class `name` containing "[SEED]". On
 * re-run it tears down the previous seed (class + members + sessions +
 * traces + role row) and recreates from scratch. The educator Cognito user
 * is reused if present (AdminCreateUser fails with UsernameExistsException
 * which we tolerate; AdminSetUserPassword keeps the password fresh).
 *
 * Usage:
 *   npx tsx scripts/seed-demo.ts
 *
 * Env vars (optional):
 *   AWS_REGION                   default us-east-1
 *   COGNITO_USER_POOL_ID         REQUIRED (looked up from your TF outputs)
 *   SEED_EDUCATOR_EMAIL          default educator-demo@knowable.ca
 *   SEED_EDUCATOR_PASSWORD       default KnowableDemo2026!
 *   SEED_EDUCATOR_DISPLAY_NAME   default Ms. Chen
 *   SEED_CLASS_NAME              default "AP Calculus · Period 3 [SEED]"
 *
 * The script does NOT call Bedrock or hit any production-data table not
 * dedicated to seeded rows. It writes only to:
 *   - knowable-roles (one row)
 *   - knowable-classes (one row)
 *   - knowable-class-members (five rows)
 *   - knowable-sessions (50–70 rows)
 *   - knowable-session-traces (50–70 rows)
 */

import { randomUUID, randomBytes } from "node:crypto";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
  UserNotFoundException,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  DeleteCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

// ---- Config ----------------------------------------------------------------

const REGION = process.env["AWS_REGION"] ?? "us-east-1";
const COGNITO_USER_POOL_ID = process.env["COGNITO_USER_POOL_ID"] ?? "";

const SEED_EMAIL =
  process.env["SEED_EDUCATOR_EMAIL"] ?? "educator-demo@knowable.ca";
const SEED_PASSWORD =
  process.env["SEED_EDUCATOR_PASSWORD"] ?? "KnowableDemo2026!";
const SEED_DISPLAY_NAME =
  process.env["SEED_EDUCATOR_DISPLAY_NAME"] ?? "Ms. Chen";
const SEED_CLASS_NAME =
  process.env["SEED_CLASS_NAME"] ?? "AP Calculus · Period 3 [SEED]";

const TABLE_ROLES = process.env["DYNAMODB_TABLE_ROLES"] ?? "knowable-roles";
const TABLE_CLASSES = process.env["DYNAMODB_TABLE_CLASSES"] ?? "knowable-classes";
const TABLE_CLASS_MEMBERS =
  process.env["DYNAMODB_TABLE_CLASS_MEMBERS"] ?? "knowable-class-members";
const TABLE_SESSIONS =
  process.env["DYNAMODB_TABLE_SESSIONS"] ?? "knowable-sessions";
const TABLE_SESSION_TRACES =
  process.env["DYNAMODB_TABLE_SESSION_TRACES"] ?? "knowable-session-traces";

// ---- Clients ---------------------------------------------------------------

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

// ---- Class code generator (mirrors src/lib/classes.ts) --------------------

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateClassCode(): string {
  const bytes = randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) {
    const b = bytes[i] ?? 0;
    code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  return code;
}

// ---- Cognito helpers -------------------------------------------------------

interface CognitoEducator {
  username: string; // UUID, also the Cognito sub
  sub: string;
  email: string;
  passwordWasReset: boolean;
}

async function findEducatorByEmail(email: string): Promise<string | null> {
  // Email is configured as an alias attribute on the pool, so AdminGetUser
  // resolves email → Username post-confirmation. AdminCreateUser confirms
  // the user implicitly when MessageAction=SUPPRESS + a permanent password
  // is set, so on re-runs the email alias is resolvable.
  try {
    const result = await cognito.send(
      new AdminGetUserCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        Username: email,
      })
    );
    return result.Username ?? null;
  } catch (err) {
    if (err instanceof UserNotFoundException) return null;
    throw err;
  }
}

async function ensureEducatorAccount(): Promise<CognitoEducator> {
  if (!COGNITO_USER_POOL_ID) {
    throw new Error(
      "COGNITO_USER_POOL_ID env var is required. Get it from `terraform output cognito_user_pool_id`."
    );
  }

  // 1. See if the educator already exists (re-run case)
  const existingUsername = await findEducatorByEmail(SEED_EMAIL);
  let username = existingUsername ?? randomUUID().toLowerCase();

  if (!existingUsername) {
    try {
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: COGNITO_USER_POOL_ID,
          Username: username,
          MessageAction: "SUPPRESS",
          UserAttributes: [
            { Name: "email", Value: SEED_EMAIL },
            { Name: "email_verified", Value: "true" },
          ],
        })
      );
    } catch (err) {
      if (err instanceof UsernameExistsException) {
        // Race: someone created the same username between findEducatorByEmail
        // and AdminCreateUser. Refetch by email.
        const refetched = await findEducatorByEmail(SEED_EMAIL);
        if (!refetched) throw err;
        username = refetched;
      } else {
        throw err;
      }
    }
  }

  // 2. Set/refresh the permanent password
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: username,
      Password: SEED_PASSWORD,
      Permanent: true,
    })
  );

  // 3. Re-fetch to grab the `sub` (== Cognito user UUID, used as our userId)
  const fetched = await cognito.send(
    new AdminGetUserCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: username,
    })
  );
  const subAttr = (fetched.UserAttributes ?? []).find((a) => a.Name === "sub");
  const sub = subAttr?.Value ?? username;

  return {
    username,
    sub,
    email: SEED_EMAIL,
    passwordWasReset: !!existingUsername,
  };
}

// ---- DynamoDB seed teardown -----------------------------------------------

async function findExistingSeedClassIds(): Promise<string[]> {
  // Scan by class name suffix "[SEED]" — fine for v0 single-table size.
  const out: string[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const resp = await ddb.send(
      new ScanCommand({
        TableName: TABLE_CLASSES,
        FilterExpression: "contains(#n, :seed)",
        ExpressionAttributeNames: { "#n": "name" },
        ExpressionAttributeValues: { ":seed": "[SEED]" },
        ExclusiveStartKey: cursor as Record<string, unknown> | undefined,
      })
    );
    for (const it of resp.Items ?? []) {
      const cid = it["classId"] as string | undefined;
      if (cid) out.push(cid);
    }
    cursor = resp.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);
  return out;
}

async function teardownClass(classId: string): Promise<void> {
  // 1. List all members (synthetic students)
  const memberResp = await ddb.send(
    new QueryCommand({
      TableName: TABLE_CLASS_MEMBERS,
      KeyConditionExpression: "classId = :cid",
      ExpressionAttributeValues: { ":cid": classId },
    })
  );
  const memberRows = (memberResp.Items ?? []) as Array<{
    classId: string;
    studentUserId: string;
  }>;

  // 2. For each member, delete their sessions + traces
  for (const m of memberRows) {
    // sessions: PK userId, SK sessionId
    const sessResp = await ddb.send(
      new QueryCommand({
        TableName: TABLE_SESSIONS,
        KeyConditionExpression: "userId = :uid",
        ExpressionAttributeValues: { ":uid": m.studentUserId },
      })
    );
    for (const s of sessResp.Items ?? []) {
      const sid = s["sessionId"] as string | undefined;
      if (!sid) continue;
      await ddb.send(
        new DeleteCommand({
          TableName: TABLE_SESSIONS,
          Key: { userId: m.studentUserId, sessionId: sid },
        })
      );
    }
    // traces: PK studentUserId, SK sessionId
    const traceResp = await ddb.send(
      new QueryCommand({
        TableName: TABLE_SESSION_TRACES,
        KeyConditionExpression: "studentUserId = :sid",
        ExpressionAttributeValues: { ":sid": m.studentUserId },
      })
    );
    for (const t of traceResp.Items ?? []) {
      const sid = t["sessionId"] as string | undefined;
      if (!sid) continue;
      await ddb.send(
        new DeleteCommand({
          TableName: TABLE_SESSION_TRACES,
          Key: { studentUserId: m.studentUserId, sessionId: sid },
        })
      );
    }
    // member row
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE_CLASS_MEMBERS,
        Key: { classId: m.classId, studentUserId: m.studentUserId },
      })
    );
  }

  // 3. Delete the class itself
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_CLASSES,
      Key: { classId },
    })
  );
}

// ---- Synthetic student profiles -------------------------------------------

interface StudentProfile {
  displayName: string;
  /** Pattern key used by the trace generator. */
  pattern: "strong" | "improving" | "lateNight" | "weeklySlump" | "stuck";
  /** How many sessions to generate over the 14-day window. */
  sessionCount: number;
}

const STUDENT_PROFILES: StudentProfile[] = [
  { displayName: "Maya P.", pattern: "strong", sessionCount: 13 },
  { displayName: "Jordan K.", pattern: "improving", sessionCount: 12 },
  { displayName: "Sam R.", pattern: "lateNight", sessionCount: 14 },
  { displayName: "Aisha N.", pattern: "weeklySlump", sessionCount: 11 },
  { displayName: "Diego F.", pattern: "stuck", sessionCount: 13 },
];

// ---- Trace fixtures --------------------------------------------------------

interface TraceEvent {
  ts: string;
  type: string;
  description: string;
}
interface TraceUnderstanding {
  ts: string;
  text: string;
}
interface TraceHint {
  ts: string;
  text: string;
}

interface SessionFixture {
  startedAt: Date;
  endedAt: Date;
  hintsCount: number;
  problemsCount: number;
  avgTimeToSolveMs: number;
  events: TraceEvent[];
  understandings: TraceUnderstanding[];
  hints: TraceHint[];
}

function mmss(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/** Pick from a list, deterministic given (i, j). */
function pick<T>(arr: T[], idx: number): T {
  // Caller guarantees arr.length > 0; the `as T` is safe because of that.
  return arr[idx % arr.length] as T;
}

function makeSession(
  profile: StudentProfile,
  i: number, // session index (0..N-1, oldest first)
  total: number,
  windowStart: Date,
  windowEnd: Date
): SessionFixture {
  const span = windowEnd.getTime() - windowStart.getTime();
  // Spread sessions roughly evenly across the window, jittered.
  const tBase =
    windowStart.getTime() + (span * (i + 0.5)) / total + (i % 3) * 60_000;

  // Pick start hour by pattern.
  let startHour = 16 + (i % 4); // afternoons by default (16:00–19:00)
  if (profile.pattern === "lateNight") {
    // Earlier in the window: spread; later in window: 21–23h
    startHour = i < total / 2 ? 17 + (i % 3) : 21 + (i % 3);
  } else if (profile.pattern === "weeklySlump") {
    startHour = 16 + (i % 4);
  } else if (profile.pattern === "improving") {
    startHour = 17 + (i % 3);
  }

  const start = new Date(tBase);
  start.setUTCHours(startHour, (i * 7) % 60, 0, 0);

  // Duration & hint/problem counts vary by pattern.
  let durationMin = 35;
  let hintsCount = 3;
  let problemsCount = 4;
  let avgSolveMs = 45_000;

  switch (profile.pattern) {
    case "strong":
      durationMin = 28 + (i % 5);
      hintsCount = 1 + (i % 3); // avg ~2.1
      problemsCount = 5 + (i % 3);
      avgSolveMs = 30_000 + (i % 4) * 1500; // ~32s
      break;
    case "improving": {
      const progress = i / Math.max(1, total - 1); // 0 -> 1
      durationMin = 40 - Math.round(progress * 8);
      hintsCount = Math.max(1, Math.round(7 - progress * 5)); // 7 -> 2
      problemsCount = 3 + Math.round(progress * 3);
      avgSolveMs = 70_000 - Math.round(progress * 30_000); // 70s -> 40s
      break;
    }
    case "lateNight": {
      const isLate = startHour >= 21;
      durationMin = isLate ? 50 : 32;
      hintsCount = isLate ? 6 + (i % 3) : 2 + (i % 2); // hint spike after 9pm
      problemsCount = isLate ? 3 + (i % 2) : 5 + (i % 2);
      avgSolveMs = isLate ? 95_000 : 50_000;
      break;
    }
    case "weeklySlump": {
      // Sundays = short (UTC weekday 0). All other days normal.
      const isSunday = start.getUTCDay() === 0;
      durationMin = isSunday ? 8 + (i % 4) : 32 + (i % 4);
      hintsCount = isSunday ? 1 : 3 + (i % 2);
      problemsCount = isSunday ? 1 : 4 + (i % 2);
      avgSolveMs = isSunday ? 35_000 : 50_000;
      break;
    }
    case "stuck":
      durationMin = 42 + (i % 5);
      hintsCount = 6 + (i % 3); // persistent struggle
      problemsCount = 2 + (i % 2);
      avgSolveMs = 110_000 + (i % 4) * 5_000;
      break;
  }

  const end = new Date(start.getTime() + durationMin * 60_000);

  const { events, understandings, hints } = makeTraceContent(profile, i, durationMin);

  return {
    startedAt: start,
    endedAt: end,
    hintsCount,
    problemsCount,
    avgTimeToSolveMs: avgSolveMs,
    events,
    understandings,
    hints,
  };
}

function makeTraceContent(
  profile: StudentProfile,
  i: number,
  durationMin: number
): {
  events: TraceEvent[];
  understandings: TraceUnderstanding[];
  hints: TraceHint[];
} {
  const events: TraceEvent[] = [];
  const understandings: TraceUnderstanding[] = [];
  const hints: TraceHint[] = [];

  // Common opening
  events.push({
    ts: mmss(8),
    type: "observed_write",
    description: "Student began working a quadratic equation.",
  });

  switch (profile.pattern) {
    case "strong": {
      events.push({
        ts: mmss(25),
        type: "observed_write",
        description: "Identified factorable form quickly.",
      });
      events.push({
        ts: mmss(60 + (i % 4) * 10),
        type: "problem_solved",
        description: "Reached the correct roots without prompting.",
      });
      understandings.push({
        ts: mmss(20),
        text: "Student recognizes the quadratic structure immediately and is solving by factoring.",
      });
      understandings.push({
        ts: mmss(70),
        text: "Confident execution; no signs of confusion. Moving on to a related problem.",
      });
      if ((i % 3) === 0) {
        hints.push({
          ts: mmss(90),
          text: "Try this trickier one: what changes if the leading coefficient isn't 1?",
        });
      }
      events.push({
        ts: mmss(durationMin * 60 - 30),
        type: "session_end",
        description: "Cleared all problems in the set.",
      });
      break;
    }
    case "improving": {
      const progress = i / Math.max(1, profile.sessionCount - 1);
      if (progress < 0.4) {
        events.push({
          ts: mmss(45),
          type: "likely_stuck",
          description: "Hesitating on isolating the variable.",
        });
        understandings.push({
          ts: mmss(50),
          text: "Student is unsure how to manipulate the equation to isolate x.",
        });
        hints.push({
          ts: mmss(55),
          text: "What inverse operation undoes addition?",
        });
        hints.push({
          ts: mmss(120),
          text: "After moving the constant, divide both sides by the coefficient of x.",
        });
        events.push({
          ts: mmss(190),
          type: "problem_solved",
          description: "Reached the answer with substantial scaffolding.",
        });
      } else {
        events.push({
          ts: mmss(35),
          type: "observed_write",
          description: "Set up the equation independently and started isolating x.",
        });
        understandings.push({
          ts: mmss(40),
          text: "Student now applies inverse operations without prompting.",
        });
        if (progress < 0.75) {
          hints.push({
            ts: mmss(80),
            text: "Watch the sign when you move the term across.",
          });
        }
        events.push({
          ts: mmss(110),
          type: "problem_solved",
          description: "Solved with minimal hint usage.",
        });
      }
      break;
    }
    case "lateNight": {
      const isLate = i >= profile.sessionCount / 2;
      const baseHourLabel = isLate ? "21:43" : "17:10";
      events.push({
        ts: mmss(20),
        type: "observed_write",
        description: `Started a new problem (clock ${baseHourLabel}).`,
      });
      if (isLate) {
        events.push({
          ts: mmss(60),
          type: "likely_stuck",
          description: "30s of inactivity after writing first line.",
        });
        events.push({
          ts: mmss(180),
          type: "likely_stuck",
          description: "45s pause; rechecked work twice.",
        });
        understandings.push({
          ts: mmss(70),
          text: "Student appears fatigued; pacing slowed sharply compared to earlier sessions.",
        });
        hints.push({ ts: mmss(75), text: "What's the first step you remember from class?" });
        hints.push({ ts: mmss(130), text: "Try writing each step on its own line to slow the work down." });
        hints.push({ ts: mmss(200), text: "Don't rush — this one rewards careful arithmetic." });
        hints.push({ ts: mmss(290), text: "Almost there: distribute carefully across both terms." });
        hints.push({ ts: mmss(380), text: "Check the sign on the constant before continuing." });
        events.push({
          ts: mmss(420),
          type: "problem_solved",
          description: "Got to the answer after extensive prompting.",
        });
      } else {
        understandings.push({
          ts: mmss(40),
          text: "Student is working steadily; one or two minor algebra slips.",
        });
        hints.push({ ts: mmss(85), text: "Double-check the sign when you combine like terms." });
        events.push({
          ts: mmss(170),
          type: "problem_solved",
          description: "Completed with light hint usage.",
        });
      }
      break;
    }
    case "weeklySlump": {
      const start = new Date();
      start.setUTCDate(start.getUTCDate() - (profile.sessionCount - 1 - i));
      const isSunday = start.getUTCDay() === 0;
      if (isSunday) {
        events.push({
          ts: mmss(45),
          type: "session_end",
          description: "Logged off after one short attempt.",
        });
        understandings.push({
          ts: mmss(40),
          text: "Sunday session — student attempted a single problem then ended early.",
        });
      } else {
        events.push({
          ts: mmss(60),
          type: "observed_write",
          description: "Worked through the problem set steadily.",
        });
        understandings.push({
          ts: mmss(40),
          text: "Strong weekday engagement; student is solving with normal pace.",
        });
        hints.push({
          ts: mmss(95),
          text: "Try factoring out the common term first.",
        });
        events.push({
          ts: mmss(180),
          type: "problem_solved",
          description: "Completed three problems in sequence.",
        });
      }
      break;
    }
    case "stuck": {
      // Always quadratics with negative discriminant — repeated stuckness.
      events.push({
        ts: mmss(20),
        type: "observed_write",
        description: "Wrote a quadratic with negative discriminant.",
      });
      events.push({
        ts: mmss(75 + (i % 3) * 10),
        type: "observed_write",
        description: "Attempted to factor; produced expressions that don't multiply back.",
      });
      events.push({
        ts: mmss(135),
        type: "likely_stuck",
        description: "45s of inactivity after factoring (x+2)(x+3) attempt.",
      });
      events.push({
        ts: mmss(240),
        type: "likely_stuck",
        description: "Erased work and restarted from the original equation.",
      });
      understandings.push({
        ts: mmss(80),
        text: "Student is treating the discriminant as if it were positive — is searching for two real factors that don't exist.",
      });
      understandings.push({
        ts: mmss(180),
        text: "Confusion persists: student keeps applying factoring techniques without recognizing the discriminant condition.",
      });
      understandings.push({
        ts: mmss(260),
        text: "Student appears to not yet have integrated the relationship between b² − 4ac and real-root existence.",
      });
      hints.push({
        ts: mmss(95),
        text: "Before factoring, what's the value of b² − 4ac here?",
      });
      hints.push({
        ts: mmss(155),
        text: "If the discriminant is negative, what does that tell you about real roots?",
      });
      hints.push({
        ts: mmss(220),
        text: "Try the quadratic formula and watch what happens under the square root.",
      });
      hints.push({
        ts: mmss(310),
        text: "It's okay — this problem has no real solutions. The square root of a negative is the signal.",
      });
      events.push({
        ts: mmss(360),
        type: "session_end",
        description: "Ended without a clean resolution; teacher follow-up recommended.",
      });
      break;
    }
  }

  // Filter out any items that overshoot the duration; keep payloads tight.
  const maxSec = durationMin * 60;
  function inWindow(t: { ts: string }): boolean {
    const [m, s] = t.ts.split(":").map((x) => parseInt(x, 10));
    if (m === undefined || s === undefined) return true;
    return m * 60 + s <= maxSec;
  }
  return {
    events: events.filter(inWindow),
    understandings: understandings.filter(inWindow),
    hints: hints.filter(inWindow),
  };
}

// ---- Seed orchestration ----------------------------------------------------

async function writeRoleRow(sub: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE_ROLES,
      Item: {
        userId: sub,
        role: "educator",
        email: SEED_EMAIL,
        displayName: SEED_DISPLAY_NAME,
        createdAt: new Date().toISOString(),
      },
    })
  );
}

interface ClassRow {
  classId: string;
  educatorId: string;
  name: string;
  code: string;
  createdAt: string;
  codeExpiresAt: string;
}

async function writeClassRow(educatorSub: string): Promise<ClassRow> {
  const classId = randomUUID();
  const code = generateClassCode();
  const createdAt = new Date();
  const codeExpiresAt = new Date(createdAt.getTime() + 90 * 86_400 * 1000);
  const row: ClassRow = {
    classId,
    educatorId: educatorSub,
    name: SEED_CLASS_NAME,
    code,
    createdAt: createdAt.toISOString(),
    codeExpiresAt: codeExpiresAt.toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: TABLES.classes, Item: row }));
  return row;
}

const TABLES = {
  roles: TABLE_ROLES,
  classes: TABLE_CLASSES,
  classMembers: TABLE_CLASS_MEMBERS,
  sessions: TABLE_SESSIONS,
  sessionTraces: TABLE_SESSION_TRACES,
} as const;

async function seedStudent(
  classId: string,
  profile: StudentProfile
): Promise<string> {
  const studentUserId = randomUUID();
  const joinedAt = new Date();
  joinedAt.setUTCDate(joinedAt.getUTCDate() - 14);

  await ddb.send(
    new PutCommand({
      TableName: TABLES.classMembers,
      Item: {
        classId,
        studentUserId,
        joinedAt: joinedAt.toISOString(),
        displayName: profile.displayName,
        sharingTier: "stats+activity",
      },
    })
  );

  const now = new Date();
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - 14 * 86_400 * 1000);

  for (let i = 0; i < profile.sessionCount; i++) {
    const session = makeSession(profile, i, profile.sessionCount, windowStart, windowEnd);
    const sessionId = randomUUID();

    // 1. knowable-sessions row (matches src/lib/dynamo.ts SessionRecord)
    await ddb.send(
      new PutCommand({
        TableName: TABLES.sessions,
        Item: {
          userId: studentUserId,
          sessionId,
          startedAt: session.startedAt.toISOString(),
          endedAt: session.endedAt.toISOString(),
          hintsCount: session.hintsCount,
          problemsCount: session.problemsCount,
          avgTimeToSolveMs: session.avgTimeToSolveMs,
        },
      })
    );

    // 2. knowable-session-traces row (matches share.ts writer shape)
    const ttl = Math.floor(session.endedAt.getTime() / 1000) + 90 * 86_400;
    await ddb.send(
      new PutCommand({
        TableName: TABLES.sessionTraces,
        Item: {
          studentUserId,
          sessionId,
          classId,
          startedAt: session.startedAt.toISOString(),
          endedAt: session.endedAt.toISOString(),
          events: session.events,
          understandings: session.understandings,
          hints: session.hints,
          ttl,
        },
      })
    );
  }

  return studentUserId;
}

async function ensureCleanSlate(): Promise<void> {
  const existing = await findExistingSeedClassIds();
  for (const cid of existing) {
    console.log(`  · tearing down previous seed class ${cid}`);
    await teardownClass(cid);
  }
}

async function deleteRoleIfExists(sub: string): Promise<void> {
  const got = await ddb.send(
    new GetCommand({
      TableName: TABLES.roles,
      Key: { userId: sub, role: "educator" },
    })
  );
  if (got.Item) {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLES.roles,
        Key: { userId: sub, role: "educator" },
      })
    );
  }
}

async function main(): Promise<void> {
  console.log("=== Knowable demo seed ===");
  console.log(`  region:           ${REGION}`);
  console.log(`  user pool:        ${COGNITO_USER_POOL_ID || "<unset>"}`);
  console.log(`  educator email:   ${SEED_EMAIL}`);
  console.log(`  class name:       ${SEED_CLASS_NAME}`);
  console.log("");

  console.log("[1/5] Ensuring Cognito educator account…");
  const educator = await ensureEducatorAccount();
  console.log(
    `  · username=${educator.username} sub=${educator.sub} (${
      educator.passwordWasReset ? "password reset on existing user" : "new user"
    })`
  );

  console.log("[2/5] Tearing down any prior seed class…");
  await ensureCleanSlate();
  // Refresh the educator's role row so displayName updates take effect.
  await deleteRoleIfExists(educator.sub);

  console.log("[3/5] Writing knowable-roles row…");
  await writeRoleRow(educator.sub);

  console.log("[4/5] Creating class + members…");
  const cls = await writeClassRow(educator.sub);
  console.log(`  · classId=${cls.classId} code=${cls.code}`);

  console.log("[5/5] Seeding 5 students × ~12 sessions over 14 days…");
  for (const profile of STUDENT_PROFILES) {
    const sid = await seedStudent(cls.classId, profile);
    console.log(`  · ${profile.displayName.padEnd(10)} (${profile.pattern}) studentUserId=${sid}`);
  }

  console.log("");
  console.log("=== Seed complete ===");
  console.log("");
  console.log("Demo credentials (use these to log in at platform.knowable.ca):");
  console.log(`  email:    ${SEED_EMAIL}`);
  console.log(`  password: ${SEED_PASSWORD}`);
  console.log("");
  console.log(`Class code: ${cls.code}  (visible on the dashboard for the educator)`);
  console.log("");
  console.log("Re-run this script anytime to reset the seed; it is idempotent.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exitCode = 1;
});
