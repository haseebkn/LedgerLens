# Secret containers only. Their values are set outside Terraform with
# `aws secretsmanager put-secret-value` (see README), so no API key,
# token or password is ever written to Terraform state.

resource "aws_secretsmanager_secret" "anthropic_api_key" {
  name = "${var.project_name}/anthropic-api-key"
}

resource "aws_secretsmanager_secret" "retrieval_service_token" {
  name = "${var.project_name}/retrieval-service-token"
}

resource "aws_secretsmanager_secret" "demo_password" {
  name = "${var.project_name}/demo-password"
}

# Earlier versions of this stack stored the first two values from
# variables, which put them in state. These blocks make Terraform forget
# those versions without deleting them, so a running deployment keeps its
# secrets. Rotate both values after upgrading: the old state still holds
# them in plaintext.
removed {
  from = aws_secretsmanager_secret_version.anthropic_api_key

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_secretsmanager_secret_version.retrieval_service_token

  lifecycle {
    destroy = false
  }
}
