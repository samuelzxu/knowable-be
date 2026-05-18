# CloudWatch alarms + SNS topic for knowable infrastructure.
#
# Single SNS topic with email subscription. AWS sends a confirmation
# email once after `terraform apply`; click the link in that email to
# activate notifications. Without confirmation, alarms still fire and
# CloudWatch records the state change, but no email is delivered.
#
# Skipped alarms (and why):
#  - ECS task restart count   → duplicates UnHealthyHostCount
#  - ALB 4xx rate              → noisy (expired tokens, dev builds)

resource "aws_sns_topic" "alarms" {
  name = "knowable-api-alarms"
}

resource "aws_sns_topic_subscription" "alarms_email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.ops_email
}

# ---- 1. ALB 5xx — the ALB itself returning 5xx ---------------------
# Not target 5xx (which would be the Fastify container erroring out, a
# separate signal). This is the ALB's own 5xx counter for cases like
# "no healthy targets" or routing config errors.
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "knowable-api-alb-5xx"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "HTTPCode_ELB_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "ALB returning >= 10 5xx in 5 min — no healthy targets or routing config error."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  dimensions = {
    LoadBalancer = aws_lb.api.arn_suffix
  }
}

# ---- 2. Unhealthy target hosts -------------------------------------
# Tasks failing /health — OOM, boot crash, bad image. Evaluates over 2
# consecutive 1-min periods so a single failed probe (which the ALB
# retries) doesn't page.
resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_hosts" {
  alarm_name          = "knowable-api-unhealthy-hosts"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  alarm_description   = "ALB target group has at least one unhealthy host for 2 consecutive 1-min periods."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  dimensions = {
    LoadBalancer = aws_lb.api.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }
}

# ---- 3. ECS service CPU sustained ----------------------------------
# Container Insights emits CPUUtilization per service. Sustained high
# CPU = runaway loop OR genuine load that needs autoscaling. At 0.5
# vCPU per task and Bedrock being I/O-bound, hitting 80% is unusual.
resource "aws_cloudwatch_metric_alarm" "ecs_cpu_sustained" {
  alarm_name          = "knowable-api-ecs-cpu-sustained"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "ECS service CPU >= 80% sustained for 10 min — scale up or investigate runaway loop."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  dimensions = {
    ClusterName = aws_ecs_cluster.api.name
    ServiceName = aws_ecs_service.api.name
  }
}

# ---- 4. WAF rate-based blocks --------------------------------------
# The rate-by-ip rule is configured to block at 300 req/5min/IP. This
# alarm fires when block volume itself is high — either a real attack
# or a runaway client.
resource "aws_cloudwatch_metric_alarm" "waf_rate_blocks" {
  alarm_name          = "knowable-api-waf-rate-blocks"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "BlockedRequests"
  namespace           = "AWS/WAFv2"
  period              = 300
  statistic           = "Sum"
  threshold           = 50
  alarm_description   = "WAF rate-by-ip rule blocked >= 50 requests in 5 min — attack or runaway client."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    WebACL = aws_wafv2_web_acl.api.name
    Rule   = "rate-by-ip"
    Region = var.region
  }
}

# ---- 5. CodeBuild failed builds ------------------------------------
# Manual deploys mean a build failure isn't visible unless someone
# checks. Page on first failure.
resource "aws_cloudwatch_metric_alarm" "codebuild_failed" {
  alarm_name          = "knowable-api-build-failed"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "FailedBuilds"
  namespace           = "AWS/CodeBuild"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "CodeBuild project failed — manual-trigger deploy means you need to know to retry."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    ProjectName = aws_codebuild_project.api.name
  }
}

# ---- 6. DynamoDB throttling on the hottest tables ------------------
# PAY_PER_REQUEST tables auto-scale but can still throttle on sudden
# spikes / hot partitions. Limited to the three tables most likely
# to actually get throttled (sessions, messages, session_traces).
# Adding all 14 tables would create noise on dev-only tables.
resource "aws_cloudwatch_metric_alarm" "ddb_throttled" {
  for_each = toset([
    aws_dynamodb_table.sessions.name,
    aws_dynamodb_table.messages.name,
    aws_dynamodb_table.session_traces.name,
  ])

  alarm_name          = "knowable-ddb-throttled-${each.value}"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ThrottledRequests"
  namespace           = "AWS/DynamoDB"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "DynamoDB throttling on ${each.value} >= 5 in 5 min — hot partition or unexpected spike."
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  dimensions = {
    TableName = each.value
  }
}

# ---- 7. Budget 80% early warning -----------------------------------
# Lives directly on the `aws_budgets_budget.bedrock_monthly` resource
# in budgets.tf (no CloudWatch alarm — AWS Budgets sends the email
# directly without an SNS topic).
