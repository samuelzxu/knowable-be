resource "aws_cognito_identity_provider" "apple" {
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "SignInWithApple"
  provider_type = "SignInWithApple"

  provider_details = {
    client_id                     = var.apple_services_id
    team_id                       = var.apple_team_id
    key_id                        = var.apple_key_id
    private_key                   = var.apple_private_key
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
