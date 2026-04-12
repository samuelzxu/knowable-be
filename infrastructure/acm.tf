# CloudFront requires ACM certs in us-east-1 regardless of primary region.
# Uses the explicit aliased provider defined in versions.tf.
resource "aws_acm_certificate" "landing" {
  provider = aws.us_east_1

  domain_name               = var.domain_name
  subject_alternative_names = var.alt_domain_names
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}
