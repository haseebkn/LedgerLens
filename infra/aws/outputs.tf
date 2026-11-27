output "app_url" {
  description = "Public URL of the app (HTTPS only; port 80 redirects)."
  value       = "https://${var.domain_name}"
}

output "alb_dns_name" {
  description = "Point domain_name at this (alias or CNAME) when Terraform does not manage the DNS zone."
  value       = aws_lb.main.dns_name
}

output "certificate_validation_records" {
  description = "DNS record(s) that prove you own domain_name. Terraform creates them when route53_zone_id is set; otherwise add them at your DNS provider."
  value = [for option in aws_acm_certificate.app.domain_validation_options : {
    name  = option.resource_record_name
    type  = option.resource_record_type
    value = option.resource_record_value
  }]
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "ecr_agent_repository_url" {
  value = aws_ecr_repository.agent.repository_url
}

output "ecr_web_repository_url" {
  value = aws_ecr_repository.web.repository_url
}

output "ecr_retrieval_repository_url" {
  value = aws_ecr_repository.retrieval.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}
