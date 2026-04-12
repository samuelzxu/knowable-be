terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region  = var.region
  profile = "knowable"

  default_tags {
    tags = {
      Project   = var.project
      Env       = var.env
      ManagedBy = "terraform"
    }
  }
}

# Aliased provider pinned to us-east-1 for CloudFront ACM certificates.
# CloudFront requires its ACM certs to live in us-east-1 regardless of the
# primary region. The default provider may also be us-east-1, but we keep
# this alias explicit so the region can be moved later without breaking ACM.
provider "aws" {
  alias   = "us_east_1"
  region  = "us-east-1"
  profile = "knowable"

  default_tags {
    tags = {
      Project   = var.project
      Env       = var.env
      ManagedBy = "terraform"
    }
  }
}
