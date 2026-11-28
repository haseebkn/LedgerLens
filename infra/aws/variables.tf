variable "aws_region" {
  description = "AWS region for Lambda, Cognito, S3, and SSM Parameter Store."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Short name used to prefix all resources."
  type        = string
  default     = "financial-context"
}

variable "environment" {
  description = "Deployment environment tag (prod, staging, ...)."
  type        = string
  default     = "prod"
}

variable "domain_name" {
  description = "Optional custom hostname (e.g. ledgerlens.example.com). Leave empty to use CloudFront's built-in free HTTPS URL (*.cloudfront.net) with no domain purchase or ACM setup."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Optional Route 53 hosted zone for domain_name. When set, Terraform creates the ACM validation record and CloudFront alias record. Leave empty to add DNS records at your registrar (or omit domain_name entirely)."
  type        = string
  default     = ""
}

variable "agent_model" {
  description = "Anthropic model ID used by the Lambda agent."
  type        = string
  default     = "claude-sonnet-5"
}

variable "lambda_memory_mb" {
  description = "Memory (MiB) for the Node.js 22 agent Lambda. 1024 MiB gives fast CPU/cold starts while staying inside AWS Lambda's Always Free 400,000 GB-seconds/month."
  type        = number
  default     = 1024
}

variable "lambda_timeout_seconds" {
  description = "Maximum streaming turn duration (seconds) for the agent Lambda."
  type        = number
  default     = 120
}

variable "demo_username" {
  description = "Cognito username of the shared \"Try the demo\" account. Create the user and store its password in SSM outside Terraform (see README)."
  type        = string
  default     = "demo"
}

variable "turns_per_hour" {
  description = "Chat turns each signed-in user may start per rolling hour."
  type        = number
  default     = 20
}

variable "user_tokens_per_day" {
  description = "Model tokens (input, output, and cache) each user may use per UTC day."
  type        = number
  default     = 300000
}

variable "global_tokens_per_day" {
  description = "Model tokens all users together may use per UTC day. Also set a monthly spend limit on the Anthropic workspace that owns the API key."
  type        = number
  default     = 3000000
}

variable "github_repo" {
  description = "Optional GitHub repository (owner/name, e.g. haseebkn/LedgerLens). When set, Terraform creates a least-privilege IAM role that GitHub Actions assumes via OIDC to deploy main."
  type        = string
  default     = ""
}

variable "create_github_oidc_provider" {
  description = "Set true only if your AWS account does not already have the token.actions.githubusercontent.com IAM OIDC provider."
  type        = bool
  default     = false
}

variable "github_oidc_provider_arn" {
  description = "Optional ARN of an existing GitHub OIDC provider in this AWS account. Defaults to arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com."
  type        = string
  default     = ""
}
