resource "aws_apigatewayv2_api" "http" {
  name          = "knowable-http-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PATCH", "OPTIONS"]
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

resource "aws_apigatewayv2_integration" "waitlist" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.waitlist.invoke_arn
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

# Public (no authorizer). Throttled at the route level via the stage's
# route_settings block below.
resource "aws_apigatewayv2_route" "post_waitlist" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "POST /waitlist"
  target             = "integrations/${aws_apigatewayv2_integration.waitlist.id}"
  authorization_type = "NONE"
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

resource "aws_lambda_permission" "apigw_waitlist" {
  statement_id  = "AllowAPIGatewayInvokeWaitlist"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.waitlist.function_name
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
