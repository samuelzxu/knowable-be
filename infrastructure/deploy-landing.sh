#!/usr/bin/env bash
set -euo pipefail
# Runs from repo root: ./infrastructure/deploy-landing.sh
cd "$(dirname "$0")/.."

# Read Terraform outputs for build-time env
TURNSTILE_SITE_KEY=$(cd infrastructure && terraform output -raw turnstile_site_key 2>/dev/null || echo "")
API_URL=$(cd infrastructure && terraform output -raw http_api_url 2>/dev/null || echo "")

if [ -z "$TURNSTILE_SITE_KEY" ] || [ -z "$API_URL" ]; then
  echo "ERROR: Terraform outputs not available. Run 'terraform apply' first."
  exit 1
fi

# Build
cd web/landing
npm ci
PUBLIC_TURNSTILE_SITE_KEY="$TURNSTILE_SITE_KEY" \
PUBLIC_API_URL="$API_URL" \
  npm run build
cd -

# Deploy
BUCKET=$(cd infrastructure && terraform output -raw landing_bucket_name)
DIST_ID=$(cd infrastructure && terraform output -raw landing_distribution_id)

aws s3 sync web/landing/dist/ "s3://${BUCKET}/" --delete --profile knowable
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" --profile knowable

echo "✓ Landing page deployed to https://knowable.ca"
