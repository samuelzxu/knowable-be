# SES domain identity used by Cognito to send branded HTML verification
# emails. Out of the box Cognito only sends plain-text mail (1024-char cap),
# so HTML rendering of the verification message requires a verified SES
# identity in the same region as the user pool.
#
# Rollout sequence:
#   1. terraform apply  →  creates the identity + DKIM tokens + outputs.
#   2. Add the records from `ses_dns_records` to Cloudflare DNS (DNS-only,
#      not proxied — orange cloud OFF) for `var.domain_name`.
#   3. Wait ~10 min, then `aws ses get-identity-verification-attributes`
#      should report `Success` for the domain.
#   4. SES is sandbox-mode by default in us-east-1: only verified recipient
#      addresses receive mail. For testing:
#        aws ses verify-email-identity --email-address <your-email>
#      For production, request out-of-sandbox via the AWS console.
#   5. Cognito's `email_configuration` block (see cognito.tf) routes mail
#      through this identity once verification is complete.

resource "aws_ses_domain_identity" "main" {
  domain = var.domain_name
}

resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}

# Optional MAIL FROM domain — improves deliverability + lets bounces route
# back through SES rather than Cognito. Uses a `mail.` subdomain.
resource "aws_ses_domain_mail_from" "main" {
  domain                 = aws_ses_domain_identity.main.domain
  mail_from_domain       = "mail.${aws_ses_domain_identity.main.domain}"
  behavior_on_mx_failure = "UseDefaultValue"
}
