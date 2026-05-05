#!/usr/bin/env bash
set -euo pipefail
# Runs from repo root: ./infrastructure/deploy-platform.sh
#
# Sibling of deploy-landing.sh — builds + ships the educator-tools platform
# site to s3://knowable-platform-site and invalidates its CloudFront
# distribution. Reads its config from terraform outputs unless the caller
# has already exported the PUBLIC_* vars.
cd "$(dirname "$0")/.."

# Allow caller-overrides; fall back to terraform outputs.
: "${PUBLIC_COGNITO_USER_POOL_ID:=$(cd infrastructure && terraform output -raw user_pool_id 2>/dev/null || echo "")}"
: "${PUBLIC_COGNITO_CLIENT_ID:=$(cd infrastructure && terraform output -raw user_pool_client_id 2>/dev/null || echo "")}"
: "${PUBLIC_API_BASE_URL:=$(cd infrastructure && terraform output -raw http_api_url 2>/dev/null || echo "")}"

if [ -z "$PUBLIC_COGNITO_USER_POOL_ID" ] || [ -z "$PUBLIC_COGNITO_CLIENT_ID" ] || [ -z "$PUBLIC_API_BASE_URL" ]; then
  echo "ERROR: Required env vars missing. Either export them or run 'terraform apply' first."
  echo "  PUBLIC_COGNITO_USER_POOL_ID"
  echo "  PUBLIC_COGNITO_CLIENT_ID"
  echo "  PUBLIC_API_BASE_URL"
  exit 1
fi

# Build
cd web/platform
# --legacy-peer-deps: @astrojs/tailwind@5 declares a peer of astro <6 but works
# fine against astro@6. Drop the flag once we migrate to @tailwindcss/vite.
npm ci --legacy-peer-deps
PUBLIC_COGNITO_USER_POOL_ID="$PUBLIC_COGNITO_USER_POOL_ID" \
PUBLIC_COGNITO_CLIENT_ID="$PUBLIC_COGNITO_CLIENT_ID" \
PUBLIC_API_BASE_URL="$PUBLIC_API_BASE_URL" \
  npm run build
cd -

# Deploy
BUCKET=$(cd infrastructure && terraform output -raw platform_bucket_name)
DIST_ID=$(cd infrastructure && terraform output -raw platform_distribution_id)

aws s3 sync web/platform/dist/ "s3://${BUCKET}/" --delete --profile knowable
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" --profile knowable

echo "✓ Platform site deployed to https://platform.knowable.ca"
