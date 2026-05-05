# Google OAuth identity provider.
#
# Credentials live in AWS Secrets Manager (knowable/google-oauth) — see
# secretsmanager.tf and SECRETS-ROTATION.md. The data source reads the
# JSON blob at apply-time. The (client_id, client_secret) pair is stored
# together for atomic rotation.
#
# Same two-stage caveat as Apple: secret container must exist with a value
# before this data source resolves cleanly.
data "aws_secretsmanager_secret_version" "google_oauth" {
  secret_id  = aws_secretsmanager_secret.google_oauth.id
  depends_on = [aws_secretsmanager_secret.google_oauth]
}

locals {
  google_oauth = jsondecode(data.aws_secretsmanager_secret_version.google_oauth.secret_string)
}

resource "aws_cognito_identity_provider" "google" {
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id                     = local.google_oauth.client_id
    client_secret                 = local.google_oauth.client_secret
    authorize_scopes              = "openid email profile"
    authorize_url                 = "https://accounts.google.com/o/oauth2/v2/auth"
    token_url                     = "https://www.googleapis.com/oauth2/v4/token"
    oidc_issuer                   = "https://accounts.google.com"
    token_request_method          = "POST"
    attributes_url                = "https://people.googleapis.com/v1/people/me?personFields="
    attributes_url_add_attributes = "true"
  }

  attribute_mapping = {
    email    = "email"
    name     = "name"
    picture  = "picture"
    username = "sub"
  }

  depends_on = [aws_cognito_user_pool.main]
}
