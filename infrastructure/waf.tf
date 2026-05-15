# AWS WAF v2 for the knowable-api ALB.
#
# Two rules: rate limiting by IP (the actual L7 backstop against
# burst attacks and runaway clients) and AWS-managed CommonRuleSet
# for known-bad patterns (SQLi/XSS/LFI/etc.). The ALB already has
# Shield Standard for L3/L4 floods — that's automatic and free.
#
# ------------------------------------------------------------------
# WAF GOTCHAS — IMPORTANT, READ BEFORE CHANGING
# ------------------------------------------------------------------
# CommonRuleSet's default action is BLOCK on every sub-rule. Several of
# those sub-rules false-positive against this app's specific traffic
# shape, so they're flipped to `count` (logged, not blocked):
#
#  • SizeRestrictions_BODY (8 KB body limit)
#      /reason-stream and /hint payloads carry 1-3 base64-encoded
#      notebook frames. A single ~1024px JPEG at quality 0.65 is
#      typically 50-200 KB, so request bodies routinely run 200 KB to
#      ~1 MB. With this rule active, every reasoning pass would 403.
#
#  • CrossSiteScripting_BODY (XSS pattern matching on the body)
#      The `user_query` and `system_prompt` payloads contain math/CS
#      problem text that legitimately includes substrings the WAF
#      treats as XSS: `<script>`, `onerror=`, `javascript:`, etc.
#      A worked example explaining "don't paste `<script>` into a
#      form" would otherwise get blocked.
#
#  • GenericRFI_BODY (Remote File Inclusion — URL-in-body patterns)
#      User queries can quote URLs (Bedrock docs, paper citations,
#      etc.). Blocks fire on bare http:// / https:// scheme strings
#      inside the body.
#
# If a new false-positive surfaces, find the rule name in the
# AWSManagedRulesCommonRuleSet ruleset and add another
# `rule_action_override` block here flipping it to `count {}`.
# Reference: https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-baseline.html#aws-managed-rule-groups-baseline-crs
#
# ------------------------------------------------------------------

resource "aws_wafv2_web_acl" "api" {
  name        = "knowable-api"
  description = "Application-layer protection for the knowable-api ALB: rate limiting + AWS managed common rules."
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  # Rule 1 — rate limiting. 300 requests / 5 min / IP. Keeps a single
  # client from exhausting Bedrock or ElevenLabs quota even with a
  # valid JWT. Tune up/down by watching real traffic in CloudWatch
  # metrics for `knowable-api-rate-by-ip`.
  rule {
    name     = "rate-by-ip"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 300
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "knowable-api-rate-by-ip"
    }
  }

  # Rule 2 — AWS managed common rules with the three false-positive
  # sub-rules flipped to `count` (see GOTCHAS comment above).
  rule {
    name     = "aws-common"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"

        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }

        rule_action_override {
          name = "CrossSiteScripting_BODY"
          action_to_use {
            count {}
          }
        }

        rule_action_override {
          name = "GenericRFI_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "knowable-api-aws-common"
    }
  }

  visibility_config {
    sampled_requests_enabled   = true
    cloudwatch_metrics_enabled = true
    metric_name                = "knowable-api"
  }
}

resource "aws_wafv2_web_acl_association" "api" {
  resource_arn = aws_lb.api.arn
  web_acl_arn  = aws_wafv2_web_acl.api.arn
}
