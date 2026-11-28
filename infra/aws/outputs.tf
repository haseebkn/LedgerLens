output "app_url" {
  description = "Public HTTPS URL of LedgerLens (custom domain if set, otherwise CloudFront's free *.cloudfront.net URL)."
  value       = local.has_custom_domain ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution hostname (point your custom domain CNAME/ALIAS here if using one)."
  value       = aws_cloudfront_distribution.main.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (set as GitHub Actions variable CLOUDFRONT_DISTRIBUTION_ID)."
  value       = aws_cloudfront_distribution.main.id
}

output "web_bucket" {
  description = "S3 bucket holding the static React frontend (set as GitHub Actions variable WEB_BUCKET)."
  value       = aws_s3_bucket.web.bucket
}

output "artifacts_bucket" {
  description = "S3 bucket holding SHA-tagged Lambda release zips (set as GitHub Actions variable ARTIFACTS_BUCKET)."
  value       = aws_s3_bucket.artifacts.bucket
}

output "lambda_function_name" {
  description = "Agent Lambda function name (set as GitHub Actions variable LAMBDA_FUNCTION_NAME)."
  value       = aws_lambda_function.agent.function_name
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "ssm_prefix" {
  description = "SSM Parameter Store prefix for secret values (set anthropic-api-key and demo-password under this path)."
  value       = "/${var.project_name}"
}

output "github_deploy_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC (populated when github_repo is set; copy into secret AWS_ROLE_ARN)."
  value       = local.enable_github_oidc ? aws_iam_role.github_deploy[0].arn : null
}

output "certificate_validation_records" {
  description = "DNS validation record(s) when using a custom domain without Route 53."
  value = local.has_custom_domain ? [for option in aws_acm_certificate.app[0].domain_validation_options : {
    name  = option.resource_record_name
    type  = option.resource_record_type
    value = option.resource_record_value
  }] : []
}
