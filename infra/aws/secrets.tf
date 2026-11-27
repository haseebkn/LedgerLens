resource "aws_secretsmanager_secret" "anthropic_api_key" {
  name = "${var.project_name}/anthropic-api-key"
}

resource "aws_secretsmanager_secret_version" "anthropic_api_key" {
  secret_id     = aws_secretsmanager_secret.anthropic_api_key.id
  secret_string = var.anthropic_api_key
}

resource "aws_secretsmanager_secret" "retrieval_service_token" {
  name = "${var.project_name}/retrieval-service-token"
}

resource "aws_secretsmanager_secret_version" "retrieval_service_token" {
  secret_id     = aws_secretsmanager_secret.retrieval_service_token.id
  secret_string = var.retrieval_service_token
}

# The demo account's password. No secret_version here on purpose: set the
# value with `aws secretsmanager put-secret-value` (see README) so it never
# lands in Terraform state.
resource "aws_secretsmanager_secret" "demo_password" {
  name = "${var.project_name}/demo-password"
}
