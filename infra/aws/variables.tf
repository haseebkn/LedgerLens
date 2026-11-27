variable "aws_region" {
  description = "AWS region to deploy into."
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

# Image tags are commit SHAs pushed by .github/workflows/deploy.yml, which
# also registers and deploys a task-definition revision per commit. These
# only seed the first revision; "bootstrap" does not exist, so services
# start healthy only after the first deploy-workflow run (see README).
variable "agent_image_tag" {
  description = "Initial image tag for the agent task definition. Later deploys come from CI by commit SHA."
  type        = string
  default     = "bootstrap"
}

variable "web_image_tag" {
  description = "Initial image tag for the web task definition."
  type        = string
  default     = "bootstrap"
}

variable "retrieval_image_tag" {
  description = "Initial image tag for the retrieval task definition."
  type        = string
  default     = "bootstrap"
}

variable "agent_cpu" {
  description = "Fargate task CPU units for the agent service."
  type        = number
  default     = 512
}

variable "agent_memory" {
  description = "Fargate task memory (MiB) for the agent service."
  type        = number
  default     = 1024
}

variable "retrieval_cpu" {
  description = "Fargate task CPU units for the retrieval service — sentence-transformers on CPU wants more headroom than the agent."
  type        = number
  default     = 1024
}

variable "retrieval_memory" {
  description = "Fargate task memory (MiB) for the retrieval service."
  type        = number
  default     = 3072
}

variable "web_cpu" {
  description = "Fargate task CPU units for the static web frontend."
  type        = number
  default     = 256
}

variable "web_memory" {
  description = "Fargate task memory (MiB) for the static web frontend."
  type        = number
  default     = 512
}

variable "domain_name" {
  description = "Hostname the app is served on, e.g. ledgerlens.example.com. Required: the ALB serves HTTPS only, with an ACM certificate for this name."
  type        = string
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone that contains domain_name. When set, Terraform creates the certificate's validation record and the alias record. Leave empty to add both DNS records yourself (see README)."
  type        = string
  default     = ""
}

variable "demo_username" {
  description = "Cognito username of the shared \"Try the demo\" account. Create the user and set its password outside Terraform (see README), so the password never enters state."
  type        = string
  default     = "demo"
}

variable "waf_requests_per_5_minutes" {
  description = "Per-IP request limit across the whole site, per 5-minute window, enforced by the ALB's WAF."
  type        = number
  default     = 600
}

variable "waf_demo_signins_per_5_minutes" {
  description = "Per-IP limit on POST /api/auth/demo, per 5-minute window."
  type        = number
  default     = 20
}

variable "turns_per_hour" {
  description = "Chat turns each signed-in user may start per rolling hour."
  type        = number
  default     = 20
}

variable "user_tokens_per_day" {
  description = "Model tokens (input, output and cache) each user may use per UTC day."
  type        = number
  default     = 300000
}

variable "global_tokens_per_day" {
  description = "Model tokens all users together may use per UTC day. Also set a monthly spend limit on the Anthropic workspace that owns the API key."
  type        = number
  default     = 3000000
}

variable "data_source" {
  description = "\"baked_demo\" (default): run the images' demo targets, which carry the synthetic warehouse and vector store; no EFS. \"efs\": run the default targets and mount both from EFS, which you must load yourself."
  type        = string
  default     = "baked_demo"

  validation {
    condition     = contains(["baked_demo", "efs"], var.data_source)
    error_message = "data_source must be \"baked_demo\" or \"efs\"."
  }
}
