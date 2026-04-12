output "user_pool_id" {
  description = "Cognito user pool ID."
  value       = aws_cognito_user_pool.main.id
}

output "user_pool_client_id" {
  description = "Cognito user pool client ID."
  value       = aws_cognito_user_pool_client.main.id
}

output "user_pool_domain" {
  description = "Full Cognito Hosted UI URL."
  value       = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com"
}

output "http_api_url" {
  description = "HTTP API base URL."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "region" {
  description = "Primary AWS region."
  value       = var.region
}

output "bedrock_model_id" {
  description = "Bedrock model ID used by the hint Lambda."
  value       = var.bedrock_model_id
}

output "config_fetch_ttl_minutes" {
  description = "TTL (minutes) for client-side /config cache."
  value       = var.config_fetch_ttl_minutes
}

output "landing_distribution_domain" {
  description = "CloudFront distribution domain for the landing page."
  value       = aws_cloudfront_distribution.landing.domain_name
}

output "landing_distribution_id" {
  description = "CloudFront distribution ID for the landing page."
  value       = aws_cloudfront_distribution.landing.id
}

output "landing_bucket_name" {
  description = "S3 bucket name hosting the landing page assets."
  value       = aws_s3_bucket.landing.bucket
}

output "acm_validation_records" {
  description = "DNS records to add at the registrar to validate the ACM cert."
  value = [
    for dvo in aws_acm_certificate.landing.domain_validation_options : {
      domain_name           = dvo.domain_name
      resource_record_name  = dvo.resource_record_name
      resource_record_type  = dvo.resource_record_type
      resource_record_value = dvo.resource_record_value
    }
  ]
}

output "dns_targets" {
  description = "DNS ALIAS/CNAME targets to add at the registrar for each served domain."
  value = merge(
    { (var.domain_name) = aws_cloudfront_distribution.landing.domain_name },
    { for d in var.alt_domain_names : d => aws_cloudfront_distribution.landing.domain_name }
  )
}

output "turnstile_site_key" {
  description = "Cloudflare Turnstile site key (non-sensitive) — read by the landing build script."
  value       = var.turnstile_site_key
}
