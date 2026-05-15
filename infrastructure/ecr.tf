# ECR repository for the Fastify api image.
#
# Image scanning on push (catches known CVEs in base layers). Lifecycle
# policy keeps the last 20 images so we can roll back easily but the
# repo doesn't grow unbounded.

resource "aws_ecr_repository" "api" {
  name                 = "knowable-api"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 20 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}
