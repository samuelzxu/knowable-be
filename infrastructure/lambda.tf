# Lambda zips MUST be built by `npm run build:lambdas` from the repo root
# before running `terraform apply`. The build script produces one zip per
# handler under `build/<name>.zip`. If a zip is missing, `terraform plan`
# will fail.
#
# source_code_hash ensures Terraform detects zip content changes on every
# apply — without it, Lambda may serve stale code.

locals {
  lambda_common_env = {
    AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    REGION                              = var.region
    BEDROCK_MODEL_ID                    = var.bedrock_model_id
    CONFIG_FETCH_TTL_MINUTES            = tostring(var.config_fetch_ttl_minutes)
    TURNSTILE_SECRET_NAME               = aws_secretsmanager_secret.turnstile.name
    COGNITO_USER_POOL_ID                = aws_cognito_user_pool.main.id
    COGNITO_CLIENT_ID                   = aws_cognito_user_pool_client.main.id
  }
}

resource "aws_lambda_function" "hint" {
  function_name    = "knowable-hint"
  filename         = "${path.module}/build/hint.zip"
  source_code_hash = filebase64sha256("${path.module}/build/hint.zip")
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  memory_size      = 512
  timeout          = 15

  environment {
    variables = merge(local.lambda_common_env, {
      DAILY_HINT_QUOTA_PER_USER = tostring(var.daily_hint_quota_per_user)
      DAILY_HINT_QUOTA_GLOBAL   = tostring(var.daily_hint_quota_global)
    })
  }
}

resource "aws_lambda_function" "sessions" {
  function_name    = "knowable-sessions"
  filename         = "${path.module}/build/sessions.zip"
  source_code_hash = filebase64sha256("${path.module}/build/sessions.zip")
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  memory_size      = 512
  timeout          = 15

  environment {
    variables = local.lambda_common_env
  }
}

resource "aws_lambda_function" "grades" {
  function_name    = "knowable-grades"
  filename         = "${path.module}/build/grades.zip"
  source_code_hash = filebase64sha256("${path.module}/build/grades.zip")
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  memory_size      = 512
  timeout          = 15

  environment {
    variables = local.lambda_common_env
  }
}

resource "aws_lambda_function" "telemetry" {
  function_name    = "knowable-telemetry"
  filename         = "${path.module}/build/telemetry.zip"
  source_code_hash = filebase64sha256("${path.module}/build/telemetry.zip")
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  memory_size      = 512
  timeout          = 15

  environment {
    variables = local.lambda_common_env
  }
}

resource "aws_lambda_function" "config" {
  function_name    = "knowable-config"
  filename         = "${path.module}/build/config.zip"
  source_code_hash = filebase64sha256("${path.module}/build/config.zip")
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  memory_size      = 512
  timeout          = 15

  environment {
    variables = local.lambda_common_env
  }
}

resource "aws_lambda_function" "context" {
  function_name    = "knowable-context"
  filename         = "${path.module}/build/context.zip"
  source_code_hash = filebase64sha256("${path.module}/build/context.zip")
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  memory_size      = 512
  timeout          = 30

  environment {
    variables = local.lambda_common_env
  }
}

resource "aws_lambda_function" "tts" {
  function_name    = "knowable-tts"
  filename         = "${path.module}/build/tts.zip"
  source_code_hash = filebase64sha256("${path.module}/build/tts.zip")
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  memory_size      = 512
  timeout          = 30 # ElevenLabs streaming can take a few seconds

  environment {
    variables = merge(local.lambda_common_env, {
      ELEVENLABS_SECRET_NAME      = aws_secretsmanager_secret.elevenlabs.name
      ELEVENLABS_DEFAULT_VOICE_ID = var.elevenlabs_default_voice_id
    })
  }
}

resource "aws_lambda_function" "waitlist" {
  function_name    = "knowable-waitlist"
  filename         = "${path.module}/build/waitlist.zip"
  source_code_hash = filebase64sha256("${path.module}/build/waitlist.zip")
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  memory_size      = 512
  timeout          = 15

  environment {
    variables = local.lambda_common_env
  }
}
