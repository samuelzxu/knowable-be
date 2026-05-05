# Knowable secrets rotation runbook

## When to use this

- After a credential leak. Current state (2026-05-04): the live Apple Sign-In
  private key (key id `3Q67LZUALS`) and the Google OAuth client secret were
  stored in plaintext in `infrastructure/.env.tfvars` on a developer
  machine. Both must be rotated before any public deploy. See
  `.omc/security/audit-2026-05-04.md` § CRIT-1.
- For any future rotation of Apple Sign-In or Google OAuth credentials.

The rotation has two halves:
1. **Operator-only:** revoke at the issuer (Apple / Google) and mint new
   credentials. Claude / Terraform cannot do this.
2. **Operator + Terraform:** upload the new values to AWS Secrets Manager
   and re-apply Cognito.

This runbook is the operator's checklist.

---

## Architecture overview

- Two AWS Secrets Manager secrets hold the federated-IdP credentials:
  - `knowable/apple-signin` — JSON `{"private_key", "team_id", "key_id", "services_id"}`
  - `knowable/google-oauth` — JSON `{"client_id", "client_secret"}`
- Terraform creates the **empty containers** (`secretsmanager.tf`).
  Terraform does NOT manage the values — those are uploaded by the operator.
- `cognito_idp_apple.tf` and `cognito_idp_google.tf` read the values via
  `data "aws_secretsmanager_secret_version"` at apply-time and feed them
  into the `aws_cognito_identity_provider` resource.

### Two-stage apply (first time only)

The `data "aws_secretsmanager_secret_version"` resources fail if the
secret container has no value. So on a fresh AWS account or after the
secrets are deleted you must apply in two stages:

```bash
# Stage 1 — create the empty secret containers only
cd infrastructure
terraform apply -var-file=.env.tfvars \
  -target=aws_secretsmanager_secret.apple_signin \
  -target=aws_secretsmanager_secret.google_oauth

# Stage 2 — operator uploads values (see Step 2 below)

# Stage 3 — full apply now that the data sources can resolve
terraform apply -var-file=.env.tfvars
```

For ordinary rotations (containers already exist with values) you skip
straight to Steps 1 → 2 → 3.

---

## Step 1 — Rotate at the issuers (operator only, ~10 min each)

### Apple Sign-In

1. Open <https://developer.apple.com/account/resources/authkeys/list>.
2. Sign in with the Apple ID that owns team `559K86G93B`.
3. Find the existing key `3Q67LZUALS` and click **Revoke**. Confirm.
4. Click the **+** button at the top of the Keys list to create a new key.
5. Name it `Knowable Sign in with Apple <YYYY-MM-DD>`, tick **Sign In with
   Apple**, click **Configure**, and bind it to the Knowable primary App
   ID (`ca.knowable.Knowable`). Save → Continue → Register.
6. Download the `.p8` file (you can only do this **once**).
7. Note the new **Key ID** (10-char alphanumeric) shown on the key detail
   page. You will need: the `.p8` contents, the Key ID, and your team ID
   (`559K86G93B`). The Services ID stays `ca.knowable.auth`.

### Google OAuth

1. Open <https://console.cloud.google.com/apis/credentials>.
2. Confirm you are in the Knowable Google Cloud project.
3. Find the OAuth 2.0 Client ID used for Sign in with Google
   (the one ending in `.apps.googleusercontent.com` whose existing client
   id was `4u920lijumhgv9jglp45qhn9ah` per the audit).
4. Click the client name → on the right, click **Reset Secret** → Confirm.
5. Copy the **new client secret** (shown once). The client ID is unchanged.

---

## Step 2 — Upload to Secrets Manager (one command each)

> ⚠️ **Critical: Apple's private key must be uploaded as a SINGLE LINE
> with all newlines stripped.** This is non-obvious — Cognito's
> `provider_details.private_key` does NOT accept a multi-line PEM. Per
> the [Amplify iOS Workshop docs][amplify-siwa], the correct value is
> `cat AuthKey_*.p8 | tr -d '\n'`: a single contiguous string starting
> `-----BEGIN PRIVATE KEY-----` and ending `-----END PRIVATE KEY-----`
> with no line breaks anywhere.
>
> If you upload it with `\n` escapes (which `jsondecode()` then turns
> back into real newlines, producing a multi-line PEM), Terraform
> applies cleanly but Cognito's SIWA token-exchange fails at the **first
> sign-in attempt** — apply succeeds, login breaks. Symptom: Apple
> Sign-In button works, redirects, then errors. Google sign-in works
> (different signing path).
>
> [amplify-siwa]: https://amplify-ios-workshop.go-aws.com/60_add_federation/10_signin_with_apple.html

### Apple Sign-In (single-line PEM, jq-built JSON, file:// upload)

```bash
# Replace ~/Downloads/AuthKey_<KEYID>.p8 with the actual path to your .p8
PRIVATE_KEY=$(cat ~/Downloads/AuthKey_*.p8 | tr -d '\n')

jq -n \
  --arg pk  "$PRIVATE_KEY" \
  --arg tid "559K86G93B" \
  --arg kid "<NEW_APPLE_KEY_ID>" \
  --arg sid "ca.knowable.auth" \
  '{private_key: $pk, team_id: $tid, key_id: $kid, services_id: $sid}' \
| aws secretsmanager put-secret-value \
    --profile knowable --region us-east-1 \
    --secret-id knowable/apple-signin \
    --secret-string file:///dev/stdin

unset PRIVATE_KEY
```

`jq -n` builds a clean JSON object without ever writing the key to a
disk file. `file:///dev/stdin` pipes the JSON through `aws-cli` without
running it through the shell's quoting layer (which is what corrupts
multi-line values when you try `--secret-string '{...}'` inline).

### Google OAuth

```bash
aws secretsmanager put-secret-value \
  --profile knowable --region us-east-1 \
  --secret-id knowable/google-oauth \
  --secret-string '{"client_id":"<EXISTING_CLIENT_ID>.apps.googleusercontent.com","client_secret":"<NEW_GOOGLE_SECRET>"}'
```

### Verify before re-applying Cognito

```bash
# Both keys present?
aws secretsmanager get-secret-value \
  --profile knowable --region us-east-1 \
  --secret-id knowable/apple-signin --query 'SecretString' --output text | jq 'keys'
# → ["key_id", "private_key", "services_id", "team_id"]

# Apple private_key MUST be a single line — wc -l should report 0
aws secretsmanager get-secret-value \
  --profile knowable --region us-east-1 \
  --secret-id knowable/apple-signin --query 'SecretString' --output text \
  | jq -r '.private_key' | wc -l
# → 0 ✓ (correct: single-line PEM)
# → anything else: re-upload — Cognito will fail at first sign-in

# Google
aws secretsmanager get-secret-value \
  --profile knowable --region us-east-1 \
  --secret-id knowable/google-oauth --query 'SecretString' --output text | jq 'keys'
# → ["client_id", "client_secret"]
```

> **IAM note.** Cognito does NOT read these secrets directly — Terraform
> reads them at apply-time using your CLI profile and passes the values
> to Cognito. The `knowable` profile already has admin, so no IAM changes
> are needed. The Lambda execution role's `secretsmanager_read` policy
> in `iam.tf` does not include the new ARNs because no Lambda reads them.

---

## Step 3 — Apply the Cognito IDP refresh

```bash
cd infrastructure
terraform apply -var-file=.env.tfvars \
  -target=aws_cognito_identity_provider.apple \
  -target=aws_cognito_identity_provider.google
```

Targeted apply is faster and avoids drift on unrelated resources. After
verifying the Cognito hosted UI still works (sign in via Apple, sign in
via Google), run a full `terraform apply -var-file=.env.tfvars` to clear
the targeted-apply warning.

---

## Step 4 — Delete plaintext from `.env.tfvars`

The `apple_*` and `google_*` Terraform variables are now deprecated
(empty defaults; declarations remain in `variables.tf` for one release
cycle so older `.env.tfvars` files don't error). Open
`infrastructure/.env.tfvars` and:

1. Delete every `apple_services_id`, `apple_team_id`, `apple_key_id`,
   `apple_private_key`, `google_client_id`, `google_client_secret` line.
2. Confirm the file now contains only non-sensitive vars (e.g.
   `turnstile_site_key`).
3. Run `terraform plan -var-file=.env.tfvars` and confirm the diff shows
   `0 to add, 0 to change, 0 to destroy` (or only changes you understand).

After the next release the deprecated variable declarations themselves
can be removed from `variables.tf`.

---

## Step 5 — Audit log

Record the rotation in your team's secret-rotation log:

- Date of rotation
- Old Apple Key ID (e.g. `3Q67LZUALS`)
- New Apple Key ID
- Operator who performed the rotation
- Confirmation that Apple Sign-In and Google Sign-In both work end-to-end
  on macOS app and platform.knowable.ca

---

## Appendix — Troubleshooting

**`data.aws_secretsmanager_secret_version.apple_signin` errors with
`ResourceNotFoundException` on first apply.** The container exists but
has no value. Run Step 2 first.

**`InvalidRequestException: You can't perform this operation on the
secret because it was marked for deletion.`** A previous apply ran
`terraform destroy` on the secret. Recover with
`aws secretsmanager restore-secret --secret-id knowable/apple-signin
--profile knowable --region us-east-1`, or wait for the recovery window
(currently `recovery_window_in_days = 0`, so secrets are deleted
immediately and you must re-create + re-upload).

**Cognito hosted UI returns `invalid_client` after rotation.** The
`provider_details.client_id` (Apple) is the *Services ID*, not the Key
ID. Confirm `services_id` in the secret JSON matches the Apple Services
ID configured in the developer portal (`ca.knowable.auth`).
