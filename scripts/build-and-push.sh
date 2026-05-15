#!/usr/bin/env bash
#
# Local build + push for knowable-api. Mirrors docker/buildspec.yml so
# CodeBuild and your dev machine produce equivalent images.
#
# Usage:
#   scripts/build-and-push.sh                # build, push, force ECS deploy
#   SKIP_DEPLOY=1 scripts/build-and-push.sh  # build + push only
#
# Uses your default AWS profile (or AWS_PROFILE if set). The profile
# needs ECR push perms on knowable-api and (if deploying) ecs:UpdateService
# on the knowable-api service.

set -euo pipefail

cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_REPO_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/knowable-api"
COMMIT_SHA="$(git rev-parse --short HEAD)"

echo "==> Logging in to ECR (${REGION})"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR_REPO_URI"

echo "==> Building knowable-api:sha-${COMMIT_SHA} (linux/amd64)"
# Force linux/amd64 even when building on Apple Silicon — Fargate is
# amd64 by default and we don't want runtime-arch surprises.
docker build \
  --platform linux/amd64 \
  --tag "${ECR_REPO_URI}:sha-${COMMIT_SHA}" \
  --tag "${ECR_REPO_URI}:latest" \
  -f docker/Dockerfile .

echo "==> Pushing tags"
docker push "${ECR_REPO_URI}:sha-${COMMIT_SHA}"
docker push "${ECR_REPO_URI}:latest"

if [[ "${SKIP_DEPLOY:-}" != "1" ]]; then
  echo "==> Forcing ECS rolling deploy"
  aws ecs update-service \
    --cluster knowable-api \
    --service knowable-api \
    --force-new-deployment \
    --region "$REGION" >/dev/null
  echo "==> Watch rollout with:"
  echo "    aws ecs describe-services --cluster knowable-api --services knowable-api --region ${REGION} \\"
  echo "      --query 'services[0].deployments'"
else
  echo "==> Skipping ECS deploy (SKIP_DEPLOY=1)"
fi

echo "==> Done: ${ECR_REPO_URI}:sha-${COMMIT_SHA}"
