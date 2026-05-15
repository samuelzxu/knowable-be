# ACM certificate for api.knowable.ca.
#
# Lives in the primary region (us-east-1 by default) because that's where
# the ALB lives — ALB ACM certs MUST be in the same region as the ALB, in
# contrast to CloudFront certs which require us-east-1 specifically. The
# default `aws` provider is correct here.
#
# Validation is DNS — add the CNAME from the `acm_api_validation_records`
# output to Cloudflare as DNS-only (grey cloud, NOT proxied). Validation
# typically completes within ~2 minutes of the record going live.

resource "aws_acm_certificate" "api" {
  domain_name       = var.api_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn = aws_acm_certificate.api.arn
  validation_record_fqdns = [
    for dvo in aws_acm_certificate.api.domain_validation_options : dvo.resource_record_name
  ]
}
