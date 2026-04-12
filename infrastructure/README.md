# Knowable Infrastructure

Terraform stack for the Knowable backend, Cognito auth (email + Apple + Google),
DynamoDB tables, Lambda functions, HTTP API, CloudFront-fronted Astro landing
page, ACM cert, AWS Budgets guardrail, and Secrets Manager.

All resources assume an AWS profile named `knowable` configured in
`~/.aws/credentials`.

---

## One-time bootstrap

Terraform state lives in S3 (`knowable-tf-state`) with a DynamoDB lock table
(`knowable-tf-lock`). These must exist before the main stack can be applied.

```bash
cd infrastructure/bootstrap
terraform init    # local backend
terraform apply   # creates the state bucket + lock table
```

See `bootstrap/README.md` for details and the destroy procedure.

---

## Apply the main stack

```bash
cd infrastructure

# First, build Lambda zips from the repo root. Terraform reads them at plan time.
( cd .. && npm run build )

# Copy the secret-vars template and fill in Apple + Google + Turnstile values.
cp .env.tfvars.example .env.tfvars
$EDITOR .env.tfvars

terraform init
terraform plan  -var-file=.env.tfvars
terraform apply -var-file=.env.tfvars
```

### What gets created

- Cognito user pool, Hosted UI domain `knowable-auth`, user pool client
  (email + Apple + Google), Apple/Google identity providers.
- DynamoDB: `knowable-sessions`, `knowable-problems`, `knowable-hints`,
  `knowable-grades`, `knowable-quota`, `knowable-telemetry`, `knowable-config`,
  `knowable-waitlist`. All PAY_PER_REQUEST, all with PITR enabled.
- IAM: `knowable-lambda-exec` role, `knowable-dynamodb-rw` inline policy,
  `knowable-secretsmanager-read` inline policy, `knowable-bedrock-invoke`
  **separate managed policy** (so Budgets can detach it).
- Lambdas: `hint`, `sessions`, `grades`, `telemetry`, `config`, `waitlist`.
- HTTP API with Cognito JWT authorizer. `POST /waitlist` is public and
  route-throttled (burst 10 / rate 5).
- ACM cert in us-east-1 for `knowable.ca` + `www.knowable.ca` (DNS validation).
- CloudFront distribution + S3 bucket + OAC for the Astro landing page.
- AWS Budgets monthly Bedrock budget with IAM detach action.
- Secrets Manager secret `knowable/turnstile/secret` (empty, user populates).

---

## Post-apply runbook

### 1. Populate the Turnstile secret

The secret is created empty. After creating a Turnstile site at
<https://dash.cloudflare.com/?to=/:account/turnstile>, push the secret key:

```bash
aws secretsmanager put-secret-value \
  --profile knowable \
  --secret-id knowable/turnstile/secret \
  --secret-string "<turnstile_secret>"
```

### 2. DNS setup

```bash
terraform output dns_targets
terraform output acm_validation_records
```

Add the ALIAS/CNAME targets and the ACM validation CNAMEs at your registrar.
The ACM cert typically validates within 5–30 minutes after the records
propagate. See `docs/DNS-SETUP.md` for a registrar-by-registrar walkthrough.

### 3. Apple Developer Portal checklist

Manual steps that must be completed before Apple Sign-In works:

- [ ] Create an **App ID** in the Apple Developer Portal (Identifiers → App IDs).
- [ ] Enable the **Sign In with Apple** capability on the App ID.
- [ ] Create a **Services ID** (e.g. `ca.knowable.auth`) and enable Sign In with Apple on it.
- [ ] Configure the Services ID with:
  - Domain: `knowable-auth.auth.us-east-1.amazoncognito.com`
  - Return URL: `https://knowable-auth.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`
- [ ] Create a **Sign in with Apple Key** (Keys → + → Sign In with Apple).
  Download the `.p8` file once — it cannot be re-downloaded.
- [ ] Note the **Team ID** (top-right of the portal), the **Key ID** (key detail page), and the **Services ID**.
- [ ] Put those four values into `infrastructure/.env.tfvars` under
  `apple_services_id`, `apple_team_id`, `apple_key_id`, `apple_private_key`.
- [ ] `terraform apply -var-file=.env.tfvars` to propagate them to Cognito.

### 4. Google OAuth setup

- [ ] Create an OAuth 2.0 client ID in the Google Cloud Console.
- [ ] Authorized redirect URI: `https://knowable-auth.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`.
- [ ] Put `google_client_id` and `google_client_secret` into `.env.tfvars`.

### 5. Landing page deploy

```bash
./deploy-landing.sh
```

(See `deploy-landing.sh` — added in Phase 6.5.)

---

## Operational runbooks

### Budgets re-attach (after IAM detach fires)

When monthly Bedrock spend crosses `$var.monthly_budget_usd`, AWS Budgets
detaches the `knowable-bedrock-invoke` managed policy from the Lambda role.
All hint calls start returning 500 (AccessDenied on Bedrock) until re-attached.

**Latency note**: Budgets actions can lag 8–12 hours after the threshold is
crossed. The authoritative fast-path circuit breaker is the `knowable-quota`
global 500/day row (see global quota reset below). Budgets is the slow,
belt-and-suspenders layer.

Re-attach manually once you are ready to resume:

```bash
aws iam attach-role-policy \
  --profile knowable \
  --role-name knowable-lambda-exec \
  --policy-arn "$(terraform output -raw bedrock_invoke_policy_arn 2>/dev/null || \
    aws iam list-policies --profile knowable --scope Local \
      --query 'Policies[?PolicyName==`knowable-bedrock-invoke`].Arn | [0]' --output text)"
```

Or re-run `terraform apply` — Terraform will reconcile the missing attachment.

### Global quota reset

The `knowable-quota` table holds a special row with PK `knowable-quota#GLOBAL`
and SK `yyyymmdd` used as the 500/day ceiling. To reset for the current day:

```bash
TODAY=$(date -u +%Y%m%d)
aws dynamodb delete-item \
  --profile knowable \
  --table-name knowable-quota \
  --key "{\"userId\":{\"S\":\"knowable-quota#GLOBAL\"},\"yyyymmdd\":{\"S\":\"$TODAY\"}}"
```

The Lambda will lazily recreate it on the next hint call.

### SRP upgrade path (Cognito)

The pool is configured with `ALLOW_USER_PASSWORD_AUTH` for MVP speed. To
upgrade to SRP:

1. Add `ALLOW_USER_SRP_AUTH` to `explicit_auth_flows` in `cognito.tf`.
2. `terraform apply`.
3. Ship a new client build that uses the SRP flow (`InitiateAuth` with
   `AuthFlow = USER_SRP_AUTH` and the SRP challenge dance).
4. Once all clients are on SRP, remove `ALLOW_USER_PASSWORD_AUTH` and
   `terraform apply` again. See `docs/AUTH-UPGRADE.md`.

---

## Destroying

```bash
cd infrastructure
terraform destroy -var-file=.env.tfvars
```

Then optionally destroy the bootstrap stack (see `bootstrap/README.md`).

The S3 landing bucket is configured with versioning; emptying it before
destroy may require `aws s3 rm --recursive` first.
