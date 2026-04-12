resource "aws_secretsmanager_secret" "turnstile" {
  name                    = "knowable/turnstile/secret"
  description             = "Cloudflare Turnstile secret key. Populate manually after creating a Turnstile site."
  recovery_window_in_days = 0
}

# Intentionally no aws_secretsmanager_secret_version: the user populates the
# secret manually with:
#   aws secretsmanager put-secret-value \
#     --profile knowable \
#     --secret-id knowable/turnstile/secret \
#     --secret-string <secret>
