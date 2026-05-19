resource "aws_dynamodb_table" "sessions" {
  name         = "knowable-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "sessionId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "sessionId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Append-only timeline of every event in a session — frame captures,
# voice queries, understanding updates, hint deliveries, etc. PK on
# sessionId keeps each session in its own partition; SK is a sortable
# `${zeroPaddedTimestampMs}#${uuid}` so Queries return in chronological
# order and concurrent writes never collide. Auth is enforced at the
# API layer via a GetItem on knowable-sessions for (req.userId, sessionId)
# before any events read/write.
#
# 1y TTL: event-level fidelity matters most for recent sessions
# (educator analysis, "what was Milo doing last week?"). After a year
# the events age out; the metadata row in knowable-sessions stays
# forever so the session list itself never disappears.
resource "aws_dynamodb_table" "session_events" {
  name         = "knowable-session-events"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "sessionId"
  range_key    = "sk"

  attribute {
    name = "sessionId"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Holds both per-user (PK = userId) and global (PK = "knowable-quota#GLOBAL") rows.
# TTL expires rows ~2 days after creation so the table stays tiny.
resource "aws_dynamodb_table" "quota" {
  name         = "knowable-quota"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "yyyymmdd"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "yyyymmdd"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table" "config" {
  name         = "knowable-config"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "configKey"

  attribute {
    name = "configKey"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table" "messages" {
  name         = "knowable-messages"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "sessionId"
  range_key    = "sk"

  attribute {
    name = "sessionId"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table" "waitlist" {
  name         = "knowable-waitlist"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "email"

  attribute {
    name = "email"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# ---- Educator tools (v0) ----
# See .omc/design/educator-tools/02-architecture.md §2, §3, §11.

# Educator role lookup. Students are implicit (no row); only educators have
# rows. Access pattern: GetItem(userId, "educator").
resource "aws_dynamodb_table" "roles" {
  name         = "knowable-roles"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "role"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "role"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Class metadata. One row per class keyed on `classId` (DynamoDB rejects a
# table where hash and range key share the same attribute name, so we use
# hash-only — the spec's "PK == SK == classId" intent is preserved by the
# single-item-per-class shape). GSI `code-index` enables student
# join-by-code lookups; sparse — only active codes are written.
resource "aws_dynamodb_table" "classes" {
  name         = "knowable-classes"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "classId"

  attribute {
    name = "classId"
    type = "S"
  }

  attribute {
    name = "code"
    type = "S"
  }

  global_secondary_index {
    name            = "code-index"
    hash_key        = "code"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Class membership. Forward (classId -> students) is the base table; reverse
# (studentUserId -> class) is the `student-index` GSI for the macOS app's
# "which class am I in?" lookup.
resource "aws_dynamodb_table" "class_members" {
  name         = "knowable-class-members"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "classId"
  range_key    = "studentUserId"

  attribute {
    name = "classId"
    type = "S"
  }

  attribute {
    name = "studentUserId"
    type = "S"
  }

  global_secondary_index {
    name            = "student-index"
    hash_key        = "studentUserId"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Qualitative session traces (events, understandings, hint text). Uploaded
# only when a student is on the Stats+Activity sharing tier. TTL set to
# 90 days post endedAt by the writer Lambda.
resource "aws_dynamodb_table" "session_traces" {
  name         = "knowable-session-traces"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "studentUserId"
  range_key    = "sessionId"

  attribute {
    name = "studentUserId"
    type = "S"
  }

  attribute {
    name = "sessionId"
    type = "S"
  }

  attribute {
    name = "classId"
    type = "S"
  }

  attribute {
    name = "endedAt"
    type = "S"
  }

  global_secondary_index {
    name            = "class-time-index"
    hash_key        = "classId"
    range_key       = "endedAt"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Bedrock-Opus analysis cache. Key shape: ${educatorId}:${studentUserId}:${dayBucket}.
# 24h TTL doubles as a per-(educator,student) rate limiter — see §11.4.
resource "aws_dynamodb_table" "analyses" {
  name         = "knowable-analyses"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "cacheKey"

  attribute {
    name = "cacheKey"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Educator invite codes (pre-launch gating). One row per invite code,
# generated by the admin CLI in `scripts/create-invite.ts` and atomically
# decremented on each redemption inside `POST /educator/register`. See
# .omc/design/educator-tools/02-architecture.md §1.
resource "aws_dynamodb_table" "educator_invites" {
  name         = "knowable-educator-invites"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "code"

  attribute {
    name = "code"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}
