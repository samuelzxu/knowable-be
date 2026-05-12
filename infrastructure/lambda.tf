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

resource "aws_lambda_function" "messages" {
  function_name    = "knowable-messages"
  filename         = "${path.module}/build/messages.zip"
  source_code_hash = filebase64sha256("${path.module}/build/messages.zip")
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  memory_size      = 512
  timeout          = 15

  environment {
    variables = local.lambda_common_env
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

# Educator tools (v0). See .omc/design/educator-tools/02-architecture.md §6 Day 2.

resource "aws_lambda_function" "classes" {
  function_name    = "knowable-classes"
  filename         = "${path.module}/build/classes.zip"
  source_code_hash = filebase64sha256("${path.module}/build/classes.zip")
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  memory_size      = 256
  timeout          = 15

  environment {
    variables = merge(local.lambda_common_env, {
      DYNAMODB_TABLE_ROLES         = aws_dynamodb_table.roles.name
      DYNAMODB_TABLE_CLASSES       = aws_dynamodb_table.classes.name
      DYNAMODB_TABLE_CLASS_MEMBERS = aws_dynamodb_table.class_members.name
    })
  }
}

resource "aws_lambda_function" "educator" {
  function_name    = "knowable-educator"
  filename         = "${path.module}/build/educator.zip"
  source_code_hash = filebase64sha256("${path.module}/build/educator.zip")
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  # Day 3: Bedrock-Opus calls take time. Higher memory for faster JSON parse
  # of the prompt + response, longer timeout for the model itself.
  memory_size = 512
  timeout     = 60

  environment {
    variables = merge(local.lambda_common_env, {
      DYNAMODB_TABLE_ROLES          = aws_dynamodb_table.roles.name
      DYNAMODB_TABLE_CLASSES        = aws_dynamodb_table.classes.name
      DYNAMODB_TABLE_CLASS_MEMBERS  = aws_dynamodb_table.class_members.name
      DYNAMODB_TABLE_SESSION_TRACES = aws_dynamodb_table.session_traces.name
      DYNAMODB_TABLE_ANALYSES       = aws_dynamodb_table.analyses.name
      DYNAMODB_TABLE_SESSIONS       = aws_dynamodb_table.sessions.name
      # Day 3 §11: force the educator-analyze path to Opus 4.6 even if the
      # global var.bedrock_model_id is something cheaper for /hint.
      BEDROCK_MODEL_ID        = "us.anthropic.claude-opus-4-6-v1"
      DAILY_BEDROCK_TOKEN_CAP = "100000"
    })
  }
}

# Day 3: student-side share uploads (stats + traces). Whitelisted Zod
# schemas in src/lib/share-schemas.ts gate what's accepted.
resource "aws_lambda_function" "share" {
  function_name    = "knowable-share"
  filename         = "${path.module}/build/share.zip"
  source_code_hash = filebase64sha256("${path.module}/build/share.zip")
  role             = aws_iam_role.lambda_share.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  memory_size      = 256
  timeout          = 15

  environment {
    variables = merge(local.lambda_common_env, {
      DYNAMODB_TABLE_CLASS_MEMBERS  = aws_dynamodb_table.class_members.name
      DYNAMODB_TABLE_SESSION_TRACES = aws_dynamodb_table.session_traces.name
    })
  }
}

# /reason-stream Lambda. Uses Lambda Function URL with RESPONSE_STREAM
# invoke mode so we can stream Bedrock tokens as SSE and pipeline ElevenLabs
# TTS in parallel.
resource "aws_lambda_function" "reason_stream" {
  function_name    = "knowable-reason-stream"
  filename         = "${path.module}/build/reason-stream.zip"
  source_code_hash = filebase64sha256("${path.module}/build/reason-stream.zip")
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  memory_size      = 1024
  timeout          = 60

  environment {
    variables = merge(local.lambda_common_env, {
      REASON_MODEL_ID_PASSIVE     = "us.anthropic.claude-sonnet-4-6"
      REASON_MODEL_ID_ACTIVE      = "us.anthropic.claude-sonnet-4-6"
      ELEVENLABS_SECRET_NAME      = aws_secretsmanager_secret.elevenlabs.name
      ELEVENLABS_DEFAULT_VOICE_ID = var.elevenlabs_default_voice_id
      DYNAMODB_TABLE_SESSIONS     = aws_dynamodb_table.sessions.name
      DYNAMODB_TABLE_MESSAGES     = aws_dynamodb_table.messages.name
      # Capture (frames, request_context, sonnet_response) tuples when the
      # client request body has `capture: true`. Bucket defined in
      # finetune.tf with IAM grant attached to lambda_exec.
      FINETUNE_TRACE_BUCKET       = aws_s3_bucket.finetune_traces.id
    })
  }
}

resource "aws_lambda_function_url" "reason_stream" {
  function_name      = aws_lambda_function.reason_stream.function_name
  authorization_type = "NONE"
  invoke_mode        = "RESPONSE_STREAM"

  cors {
    allow_credentials = false
    allow_origins     = ["*"]
    allow_methods     = ["POST"]
    allow_headers     = ["authorization", "content-type"]
    max_age           = 300
  }
}

# Explicit public-invoke permission for the Function URL. AWS normally
# auto-creates this via the console flow; the Terraform aws_lambda_function_url
# resource does NOT attach it on its own, so without this the URL always
# returns 403 AccessDeniedException. The JWT check inside the handler is
# still our real auth - this just lets the request reach the handler.
resource "aws_lambda_permission" "reason_stream_url_invoke" {
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.reason_stream.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# Lambda Function URLs with AuthType=NONE additionally require
# lambda:InvokeFunction (not just InvokeFunctionUrl) for the request to reach
# the handler. Without this, the URL endpoint returns 403 AccessDeniedException
# at the AWS auth layer BEFORE touching the Lambda code.
resource "aws_lambda_permission" "reason_stream_invoke" {
  statement_id  = "FunctionURLAllowInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.reason_stream.function_name
  principal     = "*"
}
