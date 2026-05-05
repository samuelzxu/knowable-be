# Educator-tools web app at platform.knowable.ca.
#
# Sibling to the landing site (landing.tf): independent S3 bucket, independent
# CloudFront distribution, independent ACM cert, independent invalidation.
# Separation is the whole point — marketing keeps long CloudFront TTLs while
# the platform (auth-gated, fast-iterating) stays effectively uncached.
#
# After `terraform apply`:
#   1. Add the ACM validation CNAMEs (terraform output platform_acm_validation_records)
#      at Cloudflare. DNS-only, NOT proxied.
#   2. Once the cert validates, add a CNAME for `platform.knowable.ca` pointing
#      at terraform output platform_cname_target. DNS-only, NOT proxied.

resource "aws_s3_bucket" "platform" {
  bucket = "knowable-platform-site"
}

resource "aws_s3_bucket_ownership_controls" "platform" {
  bucket = aws_s3_bucket.platform.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "platform" {
  bucket                  = aws_s3_bucket.platform.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "platform" {
  bucket = aws_s3_bucket.platform.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_cloudfront_origin_access_control" "platform" {
  name                              = "knowable-platform-oac"
  description                       = "OAC for the Knowable platform S3 bucket."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Same Astro directory-style URL rewrite as the landing site, kept as a
# distinct CloudFront function so the platform can iterate on it independently.
resource "aws_cloudfront_function" "platform_url_rewrite" {
  name    = "knowable-platform-url-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "URL rewrite for the platform Astro static output (directory paths + class detail SPA route)"
  publish = true
  code    = <<-EOF
    function handler(event) {
      var request = event.request;
      var uri = request.uri;

      // Class detail page is a single static template (`class/_/index.html`)
      // hydrated client-side with the real classId from window.location.
      // Any /class/<anything> path → serve the placeholder template.
      var classMatch = uri.match(/^\/class\/[^\/]+\/?$/);
      if (classMatch) {
        request.uri = '/class/_/index.html';
        return request;
      }

      // If URI ends with / append index.html
      if (uri.endsWith('/')) {
        request.uri += 'index.html';
      }
      // If URI doesn't have a file extension, assume it's a directory and append /index.html
      else if (!uri.includes('.')) {
        request.uri += '/index.html';
      }

      return request;
    }
  EOF
}

# Platform-specific cache policy: no-cache. Pages are auth-gated and dynamic
# (educator dashboards), so caching them at the CDN edge would only serve
# stale data and complicate invalidation. Static JS/CSS bundles are
# content-hashed by Astro and rely on the browser cache instead.
resource "aws_cloudfront_cache_policy" "platform_no_cache" {
  name        = "knowable-platform-no-cache"
  comment     = "No-cache policy for the auth-gated platform site."
  default_ttl = 0
  min_ttl     = 0
  max_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    # CloudFront rejects `enable_accept_encoding_*` when TTLs are all 0
    # (the encoding hint only matters as part of a cache key). Both must
    # be false on a strict no-cache policy.
    enable_accept_encoding_brotli = false
    enable_accept_encoding_gzip   = false

    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_distribution" "platform" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Knowable educator-tools platform"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  aliases = [var.platform_domain_name]

  origin {
    domain_name              = aws_s3_bucket.platform.bucket_regional_domain_name
    origin_id                = "knowable-platform-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.platform.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "knowable-platform-s3"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    cache_policy_id = aws_cloudfront_cache_policy.platform_no_cache.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.platform_url_rewrite.arn
    }
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/404.html"
    error_caching_min_ttl = 60
  }

  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/404.html"
    error_caching_min_ttl = 60
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    # Reference the validation resource so distribution creation is gated on
    # the cert being validated and issued.
    acm_certificate_arn      = aws_acm_certificate_validation.platform.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

data "aws_iam_policy_document" "platform_bucket" {
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.platform.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.platform.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "platform" {
  bucket = aws_s3_bucket.platform.id
  policy = data.aws_iam_policy_document.platform_bucket.json
}

# CloudFront requires ACM certs in us-east-1. Independent from the landing
# cert so the platform can roll forward (e.g. add a `*.platform.knowable.ca`
# SAN later) without touching the marketing site.
resource "aws_acm_certificate" "platform" {
  provider = aws.us_east_1

  domain_name       = var.platform_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "platform" {
  provider = aws.us_east_1

  certificate_arn = aws_acm_certificate.platform.arn

  timeouts {
    create = "60m"
  }
}
