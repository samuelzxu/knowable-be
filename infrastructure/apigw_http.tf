resource "aws_apigatewayv2_api" "http" {
  name          = "knowable-http-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 600
  }
}

resource "aws_apigatewayv2_authorizer" "cognito_jwt" {
  api_id           = aws_apigatewayv2_api.http.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "knowable-cognito-jwt"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.main.id]
    issuer   = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
  }
}

# ---- Integrations ----

resource "aws_apigatewayv2_integration" "hint" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.hint.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "sessions" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.sessions.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "grades" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.grades.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "telemetry" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.telemetry.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "config" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.config.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "context" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.context.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "tts" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.tts.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "messages" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.messages.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "waitlist" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.waitlist.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

# Educator tools (v0). See .omc/design/educator-tools/02-architecture.md §6 Day 2.

resource "aws_apigatewayv2_integration" "classes" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.classes.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "educator" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.educator.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

# Day 3: student-side share uploads.
resource "aws_apigatewayv2_integration" "share" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.share.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

# ---- Routes (JWT-protected) ----

resource "aws_apigatewayv2_route" "post_hint" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /hint"
  target             = "integrations/${aws_apigatewayv2_integration.hint.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "post_sessions" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /sessions"
  target             = "integrations/${aws_apigatewayv2_integration.sessions.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "patch_session" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "PATCH /sessions/{id}"
  target             = "integrations/${aws_apigatewayv2_integration.sessions.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "get_sessions" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /sessions"
  target             = "integrations/${aws_apigatewayv2_integration.sessions.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "post_grades" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /grades"
  target             = "integrations/${aws_apigatewayv2_integration.grades.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "get_grades" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /grades"
  target             = "integrations/${aws_apigatewayv2_integration.grades.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "post_telemetry" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /telemetry"
  target             = "integrations/${aws_apigatewayv2_integration.telemetry.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "get_config" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /config"
  target             = "integrations/${aws_apigatewayv2_integration.config.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

# POST /context — context loop update
resource "aws_apigatewayv2_route" "post_context" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /context"
  target             = "integrations/${aws_apigatewayv2_integration.context.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

# POST /tts — text-to-speech via ElevenLabs
resource "aws_apigatewayv2_route" "post_tts" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /tts"
  target             = "integrations/${aws_apigatewayv2_integration.tts.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

# GET /messages — list chat messages for a session
resource "aws_apigatewayv2_route" "get_messages" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /messages"
  target             = "integrations/${aws_apigatewayv2_integration.messages.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

# Public (no authorizer). Throttled at the route level via the stage's
# route_settings block below.
resource "aws_apigatewayv2_route" "post_waitlist" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /waitlist"
  target             = "integrations/${aws_apigatewayv2_integration.waitlist.id}"
  authorization_type = "NONE"
}

# Educator tools (v0). 6 routes on the classes Lambda + 1 on the educator
# Lambda. All JWT-gated; per-route educator-vs-student authorization is
# enforced inside the handler via `isEducator()`.

resource "aws_apigatewayv2_route" "post_classes" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /classes"
  target             = "integrations/${aws_apigatewayv2_integration.classes.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "get_classes" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /classes"
  target             = "integrations/${aws_apigatewayv2_integration.classes.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

# Specific path before {id} so API Gateway routes /classes/membership to the
# membership branch instead of treating "membership" as the id parameter.
resource "aws_apigatewayv2_route" "get_classes_membership" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /classes/membership"
  target             = "integrations/${aws_apigatewayv2_integration.classes.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "get_class_by_id" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /classes/{id}"
  target             = "integrations/${aws_apigatewayv2_integration.classes.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "post_classes_join" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /classes/join"
  target             = "integrations/${aws_apigatewayv2_integration.classes.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "delete_class_member" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "DELETE /classes/{id}/members/{studentId}"
  target             = "integrations/${aws_apigatewayv2_integration.classes.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "post_educator_register" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /educator/register"
  target             = "integrations/${aws_apigatewayv2_integration.educator.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

# Day 3: educator dashboard + on-demand Bedrock-Opus analysis.
resource "aws_apigatewayv2_route" "get_educator_dashboard" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /educator/dashboard/{classId}"
  target             = "integrations/${aws_apigatewayv2_integration.educator.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "post_educator_analyze" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /educator/analyze"
  target             = "integrations/${aws_apigatewayv2_integration.educator.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

# Day 3: student-side share uploads. Both routes are JWT-gated and the
# membership check + Zod whitelist live in the share handler.
resource "aws_apigatewayv2_route" "post_share_stats" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /classes/{classId}/share-stats"
  target             = "integrations/${aws_apigatewayv2_integration.share.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

resource "aws_apigatewayv2_route" "post_share_trace" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /classes/{classId}/share-trace"
  target             = "integrations/${aws_apigatewayv2_integration.share.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

# ---- Lambda permissions ----

resource "aws_lambda_permission" "apigw_hint" {
  statement_id  = "AllowAPIGatewayInvokeHint"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.hint.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_sessions" {
  statement_id  = "AllowAPIGatewayInvokeSessions"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sessions.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_grades" {
  statement_id  = "AllowAPIGatewayInvokeGrades"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.grades.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_telemetry" {
  statement_id  = "AllowAPIGatewayInvokeTelemetry"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.telemetry.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_config" {
  statement_id  = "AllowAPIGatewayInvokeConfig"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.config.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_context" {
  statement_id  = "AllowAPIGatewayInvokeContext"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.context.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_tts" {
  statement_id  = "AllowAPIGatewayInvokeTTS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.tts.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_messages" {
  statement_id  = "AllowAPIGatewayInvokeMessages"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.messages.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_waitlist" {
  statement_id  = "AllowAPIGatewayInvokeWaitlist"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.waitlist.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_classes" {
  statement_id  = "AllowAPIGatewayInvokeClasses"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.classes.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_educator" {
  statement_id  = "AllowAPIGatewayInvokeEducator"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.educator.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_share" {
  statement_id  = "AllowAPIGatewayInvokeShare"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.share.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}


# ---- Access log group + stage ----

resource "aws_cloudwatch_log_group" "apigw_access" {
  name              = "/aws/apigw/knowable-http-api"
  retention_in_days = 30
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw_access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      protocol       = "$context.protocol"
      responseLength = "$context.responseLength"
    })
  }

  default_route_settings {
    throttling_burst_limit = 100
    throttling_rate_limit  = 50
  }

  # Route-level throttle on the public waitlist route only.
  route_settings {
    route_key              = aws_apigatewayv2_route.post_waitlist.route_key
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }
}
