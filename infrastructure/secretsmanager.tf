resource "aws_secretsmanager_secret" "turnstile" {
  name                    = "knowable/turnstile/secret"
  description             = "Cloudflare Turnstile secret key. Populate manually after creating a Turnstile site."
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "elevenlabs" {
  name                    = "knowable/elevenlabs/secret"
  description             = "ElevenLabs API key for TTS. Populate manually after creating an ElevenLabs account."
  recovery_window_in_days = 0
}

# ---- Federated identity provider secrets (CRIT-1, audit 2026-05-04) ----
#
# These resources are intentionally EMPTY CONTAINERS. Terraform does not write
# the secret value (no aws_secretsmanager_secret_version) because doing so
# would require the secret material to live somewhere Terraform reads —
# either committed to TF (defeats the purpose) or threaded through tfvars
# (which is exactly what we are moving away from).
#
# The operator populates these via AWS CLI after rotating at the issuer.
# See: infrastructure/SECRETS-ROTATION.md for the full runbook.
#
# Two-stage apply flow:
#   1. terraform apply creates the empty secret containers (this file).
#   2. Operator runs `aws secretsmanager put-secret-value` with the rotated
#      credentials.
#   3. Operator re-runs terraform apply (or targeted apply on the Cognito
#      IDP resources) — the data sources in cognito_idp_apple.tf and
#      cognito_idp_google.tf resolve at apply-time and feed Cognito.
#
# Quick reference (full commands in SECRETS-ROTATION.md):
#   aws secretsmanager put-secret-value \
#     --profile knowable --region us-east-1 \
#     --secret-id knowable/apple-signin \
#     --secret-string '{"private_key":"...","team_id":"...","key_id":"...","services_id":"..."}'
#
#   aws secretsmanager put-secret-value \
#     --profile knowable --region us-east-1 \
#     --secret-id knowable/google-oauth \
#     --secret-string '{"client_id":"...","client_secret":"..."}'

resource "aws_secretsmanager_secret" "apple_signin" {
  name                    = "knowable/apple-signin"
  description             = "Apple Sign-In credentials (private_key, team_id, key_id, services_id) as a JSON object. Populated manually via AWS CLI after rotating in the Apple Developer Portal."
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "google_oauth" {
  name                    = "knowable/google-oauth"
  description             = "Google OAuth 2.0 client credentials (client_id, client_secret) as a JSON object. Populated manually via AWS CLI after rotating in Google Cloud Console."
  recovery_window_in_days = 0
}

# Intentionally no aws_secretsmanager_secret_version: the user populates the
# secrets manually with:
#   aws secretsmanager put-secret-value \
#     --profile knowable \
#     --secret-id knowable/turnstile/secret \
#     --secret-string <secret>
#
#   aws secretsmanager put-secret-value \
#     --profile knowable \
#     --secret-id knowable/elevenlabs/secret \
#     --secret-string <secret>
