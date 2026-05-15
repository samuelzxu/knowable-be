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
    aws_dynamodb_table.messages.arn,
    # Educator tools (v0). Each table that has GSIs also needs its index ARNs
    # so Query against `code-index`, `student-index`, `class-time-index` works.
    aws_dynamodb_table.roles.arn,
    aws_dynamodb_table.classes.arn,
    "${aws_dynamodb_table.classes.arn}/index/*",
    aws_dynamodb_table.class_members.arn,
    "${aws_dynamodb_table.class_members.arn}/index/*",
    aws_dynamodb_table.session_traces.arn,
    "${aws_dynamodb_table.session_traces.arn}/index/*",
    aws_dynamodb_table.analyses.arn,
    aws_dynamodb_table.educator_invites.arn,
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

# `lambda_exec` is the legacy shared role. Most Lambdas still use it.
# The student-invoked `share` Lambda is exempted — see `lambda_share`
# below for the scoped role. Per-Lambda IAM split for the remaining
# Lambdas is tracked as post-Kaggle work in the security audit
# `## Recommendations beyond findings`.
resource "aws_iam_role" "lambda_exec" {
  name               = "knowable-lambda-exec"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# Restricted role for the share Lambda — student-invoked, only needs to:
#  - Update `sharingTier` on knowable-class-members (UpdateItem)
#  - Put session traces (PutItem) into knowable-session-traces
#  - Read knowable-classes + knowable-class-members for membership validation
# Critically does NOT have write on knowable-roles, so a compromised share
# Lambda cannot self-elevate to educator. Closes [CRIT-2] from the
# 2026-05-04 security audit.
resource "aws_iam_role" "lambda_share" {
  name = "knowable-lambda-share"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_share_basic" {
  role       = aws_iam_role.lambda_share.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_share_dynamo" {
  name = "lambda-share-dynamo"
  role = aws_iam_role.lambda_share.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:Query",
        ]
        Resource = [
          aws_dynamodb_table.classes.arn,
          aws_dynamodb_table.class_members.arn,
          "${aws_dynamodb_table.class_members.arn}/index/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:UpdateItem",
        ]
        Resource = [
          aws_dynamodb_table.class_members.arn,
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
        ]
        Resource = [
          aws_dynamodb_table.session_traces.arn,
        ]
      },
    ]
  })
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
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
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

# ---------------------------------------------------------------------
# ECS task IAM (knowable-api Fargate service)
# ---------------------------------------------------------------------
# Two roles per ECS convention:
#   - ecs_task_execution: the ECS agent's identity. Pulls images from
#     ECR, writes CloudWatch Logs, and can read secrets from Secrets
#     Manager for env-var-from-secret injection.
#   - ecs_task: the running container's identity. Mirrors `lambda_exec`
#     permissions for the migrated endpoints — Bedrock + DynamoDB +
#     Secrets Manager + S3 finetune-traces put — because the Fastify
#     container is doing the same work as the Lambdas it replaces.
#
# We deliberately reuse the existing `dynamodb_rw` and `secretsmanager_read`
# policy documents and the `bedrock_invoke` + `finetune_traces_put`
# managed policies so the two paths can't drift apart silently.
# ---------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_task_execution" {
  name               = "knowable-api-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_managed" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ecs_task" {
  name               = "knowable-api-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "ecs_task_dynamodb_rw" {
  name   = "knowable-api-dynamodb-rw"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.dynamodb_rw.json
}

resource "aws_iam_role_policy" "ecs_task_secretsmanager_read" {
  name   = "knowable-api-secretsmanager-read"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.secretsmanager_read.json
}

# Bedrock invoke — reuse the same managed policy that AWS Budgets is
# wired to detach on cost overrun. NOTE: the existing budget automation
# only knows about the lambda_exec attachment; if the budget trips, the
# ECS task role will keep its permission. Track tightening this as
# post-Kaggle work alongside the per-Lambda IAM split.
resource "aws_iam_role_policy_attachment" "ecs_task_bedrock" {
  role       = aws_iam_role.ecs_task.name
  policy_arn = aws_iam_policy.bedrock_invoke.arn
}

# S3 PutObject on knowable-finetune-traces — same grant the reason-stream
# Lambda has today. Defined in finetune.tf.
resource "aws_iam_role_policy_attachment" "ecs_task_finetune" {
  role       = aws_iam_role.ecs_task.name
  policy_arn = aws_iam_policy.finetune_traces_put.arn
}
