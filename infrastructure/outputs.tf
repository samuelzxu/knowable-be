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

# ---- Educator-tools platform subdomain ----

output "platform_distribution_domain" {
  description = "CloudFront distribution domain name for platform.knowable.ca."
  value       = aws_cloudfront_distribution.platform.domain_name
}

output "platform_distribution_id" {
  description = "CloudFront distribution ID for the platform site (used by deploy/invalidation scripts)."
  value       = aws_cloudfront_distribution.platform.id
}

output "platform_bucket_name" {
  description = "S3 bucket name hosting the platform site assets."
  value       = aws_s3_bucket.platform.bucket
}

output "platform_acm_validation_records" {
  description = "DNS records to add at Cloudflare to validate the platform ACM cert. DNS-only, NOT proxied."
  value = [
    for dvo in aws_acm_certificate.platform.domain_validation_options : {
      domain_name           = dvo.domain_name
      resource_record_name  = dvo.resource_record_name
      resource_record_type  = dvo.resource_record_type
      resource_record_value = dvo.resource_record_value
    }
  ]
}

output "platform_cname_target" {
  description = "Value to set as the platform.knowable.ca CNAME target in Cloudflare (DNS-only)."
  value       = aws_cloudfront_distribution.platform.domain_name
}

output "reason_stream_url" {
  value       = aws_lambda_function_url.reason_stream.function_url
  description = "Lambda Function URL for streaming /reason-stream endpoint."
}

# ---- ECS API (api.knowable.ca) ----

output "api_acm_validation_records" {
  description = "DNS records to add to Cloudflare to validate the api.knowable.ca ACM cert. DNS-only (grey cloud), NOT proxied."
  value = [
    for dvo in aws_acm_certificate.api.domain_validation_options : {
      domain_name           = dvo.domain_name
      resource_record_name  = dvo.resource_record_name
      resource_record_type  = dvo.resource_record_type
      resource_record_value = dvo.resource_record_value
    }
  ]
}

output "api_ecr_repo_url" {
  description = "ECR repository URL for the knowable-api Docker image. Tag images as :sha-<commit> + :latest."
  value       = aws_ecr_repository.api.repository_url
}

output "api_codebuild_project_name" {
  description = "CodeBuild project name. Trigger a build with `aws codebuild start-build --project-name <this>`."
  value       = aws_codebuild_project.api.name
}

output "api_alb_dns_name" {
  description = "ALB DNS name. Add a CNAME at Cloudflare: api.knowable.ca → <this value>. DNS-only (grey cloud), NOT proxied."
  value       = aws_lb.api.dns_name
}

output "api_alb_zone_id" {
  description = "ALB hosted zone ID (Route53 ALIAS users only — Cloudflare uses CNAME instead)."
  value       = aws_lb.api.zone_id
}

output "api_ecs_cluster_name" {
  description = "ECS cluster name. Matches the CodeBuild ECS_CLUSTER_NAME env var."
  value       = aws_ecs_cluster.api.name
}

output "api_ecs_service_name" {
  description = "ECS service name. Use with `aws ecs update-service --force-new-deployment` for manual rollouts."
  value       = aws_ecs_service.api.name
}

# DNS records for SES domain verification + DKIM. Add these to Cloudflare
# (DNS-only, NOT proxied — orange cloud OFF). Verification typically completes
# within ~10 minutes once the records are live.
output "ses_dns_records" {
  description = "DNS records to add to Cloudflare for SES domain identity + DKIM. All records should be set to 'DNS only' (no orange-cloud proxy)."
  value = {
    domain_verification = {
      name  = "_amazonses.${aws_ses_domain_identity.main.domain}"
      type  = "TXT"
      value = aws_ses_domain_identity.main.verification_token
    }
    dkim = [
      for token in aws_ses_domain_dkim.main.dkim_tokens : {
        name  = "${token}._domainkey.${aws_ses_domain_identity.main.domain}"
        type  = "CNAME"
        value = "${token}.dkim.amazonses.com"
      }
    ]
    mail_from_mx = {
      name  = aws_ses_domain_mail_from.main.mail_from_domain
      type  = "MX"
      value = "10 feedback-smtp.${var.region}.amazonses.com"
    }
    mail_from_spf = {
      name  = aws_ses_domain_mail_from.main.mail_from_domain
      type  = "TXT"
      value = "v=spf1 include:amazonses.com ~all"
    }
  }
}
