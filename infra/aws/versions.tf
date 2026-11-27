terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state in S3 with a DynamoDB lock, configured at init time:
  #   terraform init -backend-config=backend.hcl
  # (copy backend.hcl.example; create the bucket and table once with
  # bootstrap/). CI validates with `terraform init -backend=false`.
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
}
