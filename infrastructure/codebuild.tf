# CodeBuild project that builds the knowable-api Docker image and pushes
# it to ECR, then triggers an ECS rolling deploy. Triggered manually via
#
#   aws codebuild start-build --project-name knowable-api-build
#
# No webhooks, no GitHub OAuth, no CodeStar Connection — the source repo
# is public so CodeBuild's `git clone` works unauthenticated.

# ---- Service role ----

resource "aws_iam_role" "codebuild" {
  name = "knowable-api-codebuild"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
    }]
  })
}

data "aws_iam_policy_document" "codebuild" {
  # CloudWatch Logs for build output.
  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/codebuild/*",
    ]
  }

  # Push to ECR. GetAuthorizationToken must be `*` per AWS docs (it's an
  # account-level operation, not resource-scoped).
  statement {
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.api.arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # Roll out the new image. buildspec's post_build runs:
  #   aws ecs update-service --force-new-deployment ...
  # to make ECS re-pull the image. Scoped to the api service only.
  statement {
    effect    = "Allow"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "codebuild" {
  name   = "knowable-api-codebuild"
  role   = aws_iam_role.codebuild.id
  policy = data.aws_iam_policy_document.codebuild.json
}

# ---- CodeBuild project ----

resource "aws_codebuild_project" "api" {
  name         = "knowable-api-build"
  description  = "Builds the knowable-api Docker image and pushes to ECR, then forces an ECS rolling deploy."
  service_role = aws_iam_role.codebuild.arn

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/standard:7.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = true # docker build needs the Docker daemon

    environment_variable {
      name  = "AWS_ACCOUNT_ID"
      value = data.aws_caller_identity.current.account_id
    }
    environment_variable {
      name  = "AWS_REGION"
      value = var.region
    }
    environment_variable {
      name  = "ECR_REPO_URI"
      value = aws_ecr_repository.api.repository_url
    }
    # Hardcoded here on purpose — the ECS cluster + service Terraform
    # lands in alb.tf/ecs.tf (Phase 1b) and we want CodeBuild's IAM and
    # config to apply independently of those. The names match what
    # ecs.tf will set them to.
    environment_variable {
      name  = "ECS_CLUSTER_NAME"
      value = "knowable-api"
    }
    environment_variable {
      name  = "ECS_SERVICE_NAME"
      value = "knowable-api"
    }
  }

  source {
    type            = "GITHUB"
    location        = var.codebuild_source_url
    git_clone_depth = 1
    buildspec       = "docker/buildspec.yml"
  }

  source_version = var.codebuild_source_branch

  logs_config {
    cloudwatch_logs {
      group_name  = "/aws/codebuild/knowable-api"
      stream_name = "build"
    }
  }
}
