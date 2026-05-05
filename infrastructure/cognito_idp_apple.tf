# Apple Sign-In identity provider.
#
# Credentials live in AWS Secrets Manager (knowable/apple-signin) — see
# secretsmanager.tf and SECRETS-ROTATION.md. The data source below reads
# the JSON blob at apply-time. The four-tuple (private_key, team_id,
# key_id, services_id) is stored together for atomic rotation.
#
# IMPORTANT: For first-time apply on a fresh AWS account the secret
# container does not yet exist as a populated value, so this data source
# will fail. The runbook describes the two-stage flow:
#   stage 1: apply only the secret containers
#   stage 2: operator put-secret-value, then apply the rest
data "aws_secretsmanager_secret_version" "apple_signin" {
  secret_id  = aws_secretsmanager_secret.apple_signin.id
  depends_on = [aws_secretsmanager_secret.apple_signin]
}

locals {
  apple_signin = jsondecode(data.aws_secretsmanager_secret_version.apple_signin.secret_string)
}

resource "aws_cognito_identity_provider" "apple" {
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "SignInWithApple"
  provider_type = "SignInWithApple"

  provider_details = {
    client_id                     = local.apple_signin.services_id
    team_id                       = local.apple_signin.team_id
    key_id                        = local.apple_signin.key_id
    private_key                   = local.apple_signin.private_key
    authorize_scopes              = "email name"
    authorize_url                 = "https://appleid.apple.com/auth/authorize"
    token_url                     = "https://appleid.apple.com/auth/token"
    oidc_issuer                   = "https://appleid.apple.com"
    token_request_method          = "POST"
    attributes_url_add_attributes = "false"
  }

  attribute_mapping = {
    email    = "email"
    name     = "name"
    username = "sub"
  }

  # The private_key field has a known Terraform provider bug where it's never
  # persisted in state, causing a perpetual diff and potentially overwriting
  # a working key with a broken one on each apply.
  # See: https://github.com/hashicorp/terraform-provider-aws/issues/13582
  # The key is pushed via AWS CLI instead. Do NOT remove this lifecycle block.
  lifecycle {
    ignore_changes = [provider_details["private_key"]]
  }

  depends_on = [aws_cognito_user_pool.main]
}
