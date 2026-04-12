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

# Blocks `terraform apply` until the ACM cert has been validated. On first
# apply, this resource will poll for up to 60 minutes while YOU add the DNS
# CNAMEs to your registrar. Get them with:
#   terraform output -json acm_validation_records
# Then add each record (name + value) at your registrar. Apple usually
# validates within 2-5 minutes once DNS has propagated.
#
# CloudFront's viewer_certificate references this resource's output, so
# CloudFront creation is automatically gated on validation success.
resource "aws_acm_certificate_validation" "landing" {
  provider = aws.us_east_1

  certificate_arn = aws_acm_certificate.landing.arn

  timeouts {
    create = "60m"
  }
}
