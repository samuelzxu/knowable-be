# Terraform Bootstrap

This sub-stack exists for one reason: to create the S3 bucket and DynamoDB
lock table that the main `infrastructure/` stack uses for its remote state.

It is run ONCE, at the start of the project's life. After it has run, the
main stack's `backend.tf` S3 backend becomes usable.

## One-time run procedure

From a clean checkout:

```bash
cd infrastructure/bootstrap

# Initializes a LOCAL backend (terraform.tfstate on disk). This is intentional:
# we cannot use S3 remote state until the bucket exists, hence the chicken-and-egg.
terraform init

# Review the plan. It should create:
#   - aws_s3_bucket.tf_state                ("knowable-tf-state")
#   - aws_s3_bucket_versioning.tf_state
#   - aws_s3_bucket_server_side_encryption_configuration.tf_state
#   - aws_s3_bucket_public_access_block.tf_state
#   - aws_dynamodb_table.tf_lock            ("knowable-tf-lock")
terraform plan

# Apply.
terraform apply
```

After apply succeeds, return to the main stack:

```bash
cd ..
terraform init   # picks up the S3 remote backend for the first time
terraform apply  # the real infrastructure now gets created
```

## Destroying

Only destroy `bootstrap/` AFTER you have first destroyed the main stack and
migrated or deleted the remote state. Destroying the bucket while the main
stack's state lives inside it will brick your project.

```bash
# 1. In the main stack:
cd infrastructure
terraform destroy   # remove all real infra

# 2. Remove the remote state object manually:
aws s3 rm s3://knowable-tf-state/knowable/prod.tfstate --profile knowable

# 3. Then tear down the bootstrap:
cd bootstrap
terraform destroy
```

## Notes

- The `profile = "knowable"` is hardcoded. Configure it in `~/.aws/credentials`
  before running.
- The state file for THIS bootstrap sub-stack lives at
  `bootstrap/terraform.tfstate`. Keep it safe; it's small and rarely changes.
