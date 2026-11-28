terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.74"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
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

# CloudFront requires ACM certificates to live in us-east-1 regardless of
# where the Lambda function and Cognito user pool run.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}
