data "aws_caller_identity" "current" {}

locals {
  dynamo_table_arns = [
    aws_dynamodb_table.sessions.arn,
    aws_dynamodb_table.problems.arn,
    aws_dynamodb_table.hints.arn,
    aws_dynamodb_table.grades.arn,
    aws_dynamodb_table.quota.arn,
    aws_dynamodb_table.telemetry.arn,
    aws_dynamodb_table.config.arn,
    aws_dynamodb_table.waitlist.arn,
  ]

  bedrock_model_arn = "arn:aws:bedrock:${var.region}::foundation-model/${var.bedrock_model_id}"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_exec" {
  name               = "knowable-lambda-exec"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ---- DynamoDB RW (item-level) ----

data "aws_iam_policy_document" "dynamodb_rw" {
  statement {
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = local.dynamo_table_arns
  }
}

resource "aws_iam_role_policy" "dynamodb_rw" {
  name   = "knowable-dynamodb-rw"
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.dynamodb_rw.json
}

# ---- Secrets Manager read (Turnstile secret only) ----

data "aws_iam_policy_document" "secretsmanager_read" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.turnstile.arn,
      aws_secretsmanager_secret.elevenlabs.arn,
    ]
  }
}

resource "aws_iam_role_policy" "secretsmanager_read" {
  name   = "knowable-secretsmanager-read"
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.secretsmanager_read.json
}

# ---- Bedrock invoke (SEPARATE managed policy so Budgets can detach it) ----

data "aws_iam_policy_document" "bedrock_invoke" {
  statement {
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:GetInferenceProfile",
    ]
    resources = [
      # Foundation models (direct IDs like anthropic.claude-*)
      "arn:aws:bedrock:${var.region}::foundation-model/anthropic.claude-*",
      # Inference profiles (regional IDs like us.anthropic.claude-*)
      "arn:aws:bedrock:${var.region}:${data.aws_caller_identity.current.account_id}:inference-profile/us.anthropic.*",
      # Cross-region inference may route to other regions' foundation models
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
    ]
  }

  # ListFoundationModels requires * (it's an account-level read).
  statement {
    effect    = "Allow"
    actions   = ["bedrock:ListFoundationModels"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "bedrock_invoke" {
  name        = "knowable-bedrock-invoke"
  description = "Bedrock invoke policy. Detached by AWS Budgets when the monthly cost threshold is crossed."
  policy      = data.aws_iam_policy_document.bedrock_invoke.json
}

resource "aws_iam_role_policy_attachment" "bedrock_invoke" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = aws_iam_policy.bedrock_invoke.arn
}
