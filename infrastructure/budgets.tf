# AWS Budgets Bedrock monthly cost guardrail.
#
# When monthly Bedrock spend crosses `var.monthly_budget_usd`, the budget
# action detaches the `knowable-bedrock-invoke` managed policy from the
# Lambda execution role, making all subsequent Bedrock calls fail with
# AccessDeniedException.
#
# IMPORTANT: Budgets actions can lag 8–12 hours after the threshold is
# crossed. The authoritative fast-path circuit breaker is the 500/day
# GLOBAL quota ceiling enforced in `src/handlers/hint.ts` — that returns
# 429 immediately. Budgets is the slow belt-and-suspenders mechanism.
#
# Re-attach after a budget detach is a MANUAL runbook step (see README).

data "aws_iam_policy_document" "budgets_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "budgets_action" {
  name               = "knowable-budgets-action"
  assume_role_policy = data.aws_iam_policy_document.budgets_assume.json
}

data "aws_iam_policy_document" "budgets_action" {
  statement {
    effect = "Allow"
    actions = [
      "iam:DetachRolePolicy",
      "iam:AttachRolePolicy",
      "iam:ListAttachedRolePolicies",
    ]
    resources = [aws_iam_role.lambda_exec.arn]
  }
}

resource "aws_iam_role_policy" "budgets_action" {
  name   = "knowable-budgets-action-inline"
  role   = aws_iam_role.budgets_action.id
  policy = data.aws_iam_policy_document.budgets_action.json
}

resource "aws_budgets_budget" "bedrock_monthly" {
  name         = "knowable-bedrock-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "Service"
    values = ["Amazon Bedrock"]
  }
}

resource "aws_budgets_budget_action" "detach_bedrock_policy" {
  budget_name        = aws_budgets_budget.bedrock_monthly.name
  action_type        = "APPLY_IAM_POLICY"
  approval_model     = "AUTOMATIC"
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.budgets_action.arn
  account_id         = data.aws_caller_identity.current.account_id

  action_threshold {
    action_threshold_type  = "PERCENTAGE"
    action_threshold_value = 100
  }

  definition {
    iam_action_definition {
      policy_arn = aws_iam_policy.bedrock_invoke.arn
      roles      = [aws_iam_role.lambda_exec.name]
    }
  }

  subscriber {
    address           = "ops@knowable.ca"
    subscription_type = "EMAIL"
  }
}
