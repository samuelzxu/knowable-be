# ECS Fargate cluster + task definition + service for knowable-api.
#
# Single cluster, single service, single task family. The service starts
# with desired_count = 0 (controlled by var.api_desired_count) so this
# Terraform can apply cleanly before the first image lands in ECR;
# bump to 1 once the image is pushed, then 2 once verified.

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/knowable-api"
  retention_in_days = 30
}

resource "aws_ecs_cluster" "api" {
  name = "knowable-api"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "api" {
  cluster_name       = aws_ecs_cluster.api.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    base              = 1
    weight            = 1
    capacity_provider = "FARGATE"
  }
}

# Container env. Inlines what used to be `local.lambda_common_env`
# (deleted alongside lambda.tf in the Lambda decommission) plus the
# table/secret env the Fastify service needs beyond the common set.
locals {
  api_task_env = {
    AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    REGION                              = var.region
    BEDROCK_MODEL_ID                    = var.bedrock_model_id
    CONFIG_FETCH_TTL_MINUTES            = tostring(var.config_fetch_ttl_minutes)
    TURNSTILE_SECRET_NAME               = aws_secretsmanager_secret.turnstile.name
    COGNITO_USER_POOL_ID                = aws_cognito_user_pool.main.id
    COGNITO_CLIENT_ID                   = aws_cognito_user_pool_client.main.id
    PORT                                = "3000"
    REASON_MODEL_ID_PASSIVE             = "us.anthropic.claude-sonnet-4-6"
    REASON_MODEL_ID_ACTIVE              = "us.anthropic.claude-sonnet-4-6"
    ELEVENLABS_SECRET_NAME              = aws_secretsmanager_secret.elevenlabs.name
    ELEVENLABS_DEFAULT_VOICE_ID         = var.elevenlabs_default_voice_id
    DYNAMODB_TABLE_SESSIONS             = aws_dynamodb_table.sessions.name
    DYNAMODB_TABLE_MESSAGES             = aws_dynamodb_table.messages.name
    DYNAMODB_TABLE_QUOTA                = aws_dynamodb_table.quota.name
    DYNAMODB_TABLE_CONFIG               = aws_dynamodb_table.config.name
    DAILY_HINT_QUOTA_PER_USER           = tostring(var.daily_hint_quota_per_user)
    DAILY_HINT_QUOTA_GLOBAL             = tostring(var.daily_hint_quota_global)
    FINETUNE_TRACE_BUCKET               = aws_s3_bucket.finetune_traces.id
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "knowable-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.api_task_cpu
  memory                   = var.api_task_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "knowable-api"
      image     = "${aws_ecr_repository.api.repository_url}:latest"
      essential = true

      portMappings = [{
        containerPort = 3000
        protocol      = "tcp"
      }]

      environment = [for k, v in local.api_task_env : { name = k, value = v }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "api" {
  name            = "knowable-api"
  cluster         = aws_ecs_cluster.api.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  # Allow Fastify boot time before the ALB starts pinging /health.
  # Fastify usually boots in <2s; 60s is conservative.
  health_check_grace_period_seconds = 60

  network_configuration {
    subnets          = aws_subnet.api_private[*].id
    security_groups  = [aws_security_group.ecs_task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "knowable-api"
    container_port   = 3000
  }

  # Rolling deploy: at most 200%, at least 100%. With 2 tasks, ECS
  # launches 2 new before stopping the 2 old — no SSE blip during
  # CodeBuild rollouts.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  depends_on = [aws_lb_listener.https]
}
