# Bootstrap
#
# The S3 bucket `knowable-tf-state` and DynamoDB lock table `knowable-tf-lock`
# referenced below are NOT created by this stack. They must be created ONCE
# via the tiny `bootstrap/` sub-stack (which uses a local backend) before this
# remote backend can be initialized. See `bootstrap/README.md` for the one-time
# procedure.
#
# After the bootstrap has been run:
#   1. cd infrastructure
#   2. terraform init     # initializes the remote backend below
#   3. terraform apply    # proceeds normally
#
# The `bootstrap/` sub-stack intentionally ships its own terraform state inside
# `bootstrap/terraform.tfstate` (local) so that it can be reapplied or destroyed
# without a chicken-and-egg dependency on this backend.

terraform {
  backend "s3" {
    bucket         = "knowable-tf-state"
    key            = "knowable/prod.tfstate"
    region         = "us-east-1"
    dynamodb_table = "knowable-tf-lock"
    encrypt        = true
    profile        = "knowable"
  }
}
