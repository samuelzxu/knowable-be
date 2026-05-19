#!/usr/bin/env bash
set -euo pipefail
# Runs from repo root: ./infrastructure/deploy-landing.sh
cd "$(dirname "$0")/.."

# Read Terraform outputs for build-time env
TURNSTILE_SITE_KEY=$(cd infrastructure && terraform output -raw turnstile_site_key 2>/dev/null || echo "")
# Public API origin. Was previously sourced from the `http_api_url`
# Terraform output (the Lambda+APIGW invoke URL); that endpoint was
# decommissioned alongside the ECS migration and the output went away,
# but the script wasn't updated and silently bailed. The public domain
# `api.knowable.ca` is the post-migration contract — ALB + Cloudflare
# proxy, configured outside Terraform — so hardcode it here.
API_URL="https://api.knowable.ca"

if [ -z "$TURNSTILE_SITE_KEY" ]; then
  echo "ERROR: turnstile_site_key Terraform output not available. Run 'terraform apply' first."
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
