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

resource "aws_dynamodb_table" "problems" {
  name         = "knowable-problems"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "sessionId"
  range_key    = "problemId"

  attribute {
    name = "sessionId"
    type = "S"
  }

  attribute {
    name = "problemId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table" "hints" {
  name         = "knowable-hints"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "problemId"
  range_key    = "hintId"

  attribute {
    name = "problemId"
    type = "S"
  }

  attribute {
    name = "hintId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table" "grades" {
  name         = "knowable-grades"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "loggedAtSubject"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "loggedAtSubject"
    type = "S"
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

resource "aws_dynamodb_table" "telemetry" {
  name         = "knowable-telemetry"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "ts"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "ts"
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
