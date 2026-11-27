# Sign-in for the app. Accounts are created by an administrator only; there
# is no self sign-up. The agent verifies access tokens from this pool and
# client in its own middleware (agent/src/lib/auth.ts), so the user id is
# available inside the app for per-user limits and, later, data scoping.

resource "aws_cognito_user_pool" "main" {
  name = "${var.project_name}-users"

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length    = 14
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }
}

# Public client (no secret): the agent calls InitiateAuth for the demo user
# with plain HTTPS and no AWS credentials.
resource "aws_cognito_user_pool_client" "web" {
  name         = "${var.project_name}-web"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  access_token_validity         = 1
  id_token_validity             = 1
  refresh_token_validity        = 1

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}
