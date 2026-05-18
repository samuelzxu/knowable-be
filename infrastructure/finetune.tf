# Fine-tune trace capture.
#
# Stores (request_context, frames[], sonnet_response) tuples captured from
# real /reason-stream calls when the client opts in via the
# `milo_finetune_capture` toggle. Reads of these objects only happen from
# developer machines via `aws s3 sync`; the bucket is private with all
# public access blocked.
#
# Layout written by `src/lib/trace-capture.ts`:
#   traces/{YYYY-MM-DD}/{trace_uuid}/manifest.json
#   traces/{YYYY-MM-DD}/{trace_uuid}/frame-{i}.jpg
#
# Lifecycle: 30-day expiration so a forgotten toggle can't accumulate
# unbounded storage. Override or remove when the POC stabilizes.

resource "aws_s3_bucket" "finetune_traces" {
  bucket = "knowable-finetune-traces"
}

resource "aws_s3_bucket_ownership_controls" "finetune_traces" {
  bucket = aws_s3_bucket.finetune_traces.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "finetune_traces" {
  bucket                  = aws_s3_bucket.finetune_traces.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "finetune_traces" {
  bucket = aws_s3_bucket.finetune_traces.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "finetune_traces" {
  bucket = aws_s3_bucket.finetune_traces.id
  rule {
    id     = "auto-expire-traces"
    status = "Enabled"
    filter {
      prefix = "traces/"
    }
    expiration {
      days = 30
    }
  }
}

# Allow the ECS task role to write capture objects. The role attachment
# itself lives in iam.tf (aws_iam_role_policy_attachment.ecs_task_finetune)
# so the ECS role wiring is colocated with the rest of the task IAM.
data "aws_iam_policy_document" "finetune_traces_put" {
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.finetune_traces.arn}/traces/*"]
  }
}

resource "aws_iam_policy" "finetune_traces_put" {
  name = "knowable-finetune-traces-put"
  # NOTE: do not edit `description` — AWS treats it as immutable and a
  # change forces a policy replacement, which briefly detaches the ECS
  # task role from S3 PutObject. The original text mentions the
  # reason-stream Lambda which has been decommissioned.
  description = "Allows the reason-stream Lambda to write fine-tune trace objects."
  policy      = data.aws_iam_policy_document.finetune_traces_put.json
}

output "finetune_trace_bucket" {
  description = "S3 bucket name for fine-tune trace captures."
  value       = aws_s3_bucket.finetune_traces.id
}
