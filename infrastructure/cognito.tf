resource "aws_cognito_user_pool" "main" {
  name = "${var.project}-${var.env}"

  alias_attributes         = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  # Send verification mail through SES so we can deliver branded HTML
  # (the default Cognito sender is plain-text, capped at 1024 chars and
  # 50 messages/day). DEVELOPER mode means Cognito uses our SES identity
  # rather than `no-reply@verificationemail.com`.
  email_configuration {
    email_sending_account  = "DEVELOPER"
    source_arn             = aws_ses_domain_identity.main.arn
    from_email_address     = "Knowable <noreply@${var.domain_name}>"
    reply_to_email_address = "hello@${var.domain_name}"
  }

  # HTML email shown when a user signs up. `{####}` is the only
  # placeholder Cognito interpolates — it's substituted with the 6-digit
  # verification code.
  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your Knowable verification code"
    email_message        = file("${path.module}/email-templates/verification.html")
  }

  schema {
    name                     = "email"
    attribute_data_type      = "String"
    required                 = true
    mutable                  = true
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }

  depends_on = [
    aws_ses_domain_identity.main,
  ]
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "knowable-auth"
  user_pool_id = aws_cognito_user_pool.main.id
}

resource "aws_cognito_user_pool_client" "main" {
  name         = "${var.project}-${var.env}-client"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  supported_identity_providers = [
    "COGNITO",
    "SignInWithApple",
    "Google",
  ]

  callback_urls = [
    "${var.callback_url_scheme}://auth/callback",
    "https://platform.knowable.ca/auth/callback",
  ]
  logout_urls = [
    "${var.callback_url_scheme}://auth/logout",
    "https://platform.knowable.ca/",
  ]

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true

  prevent_user_existence_errors = "ENABLED"

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  depends_on = [
    aws_cognito_identity_provider.apple,
    aws_cognito_identity_provider.google,
  ]
}
