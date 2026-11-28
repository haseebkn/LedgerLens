# Always-Free serverless compute for the Hono/Claude agent:
# - AWS Lambda (Node.js 22): 1M requests + 400,000 GB-seconds/month Always Free
# - Lambda Function URL with InvokeMode=RESPONSE_STREAM for real SSE streaming
# - SSM Parameter Store (Standard SecureStrings) for secrets: Always Free
#   (unlike Secrets Manager's per-secret monthly fee); secret values are set
#   via AWS CLI outside Terraform so they never enter Terraform state.

resource "random_password" "origin_verify" {
  length  = 32
  special = false
}

# Placeholder bundle so `terraform apply` succeeds before the first GitHub
# Actions deploy uploads the real agent + DuckDB warehouse artifact.
data "archive_file" "bootstrap" {
  type        = "zip"
  output_path = "${path.module}/.bootstrap-lambda.zip"

  source {
    filename = "dist/lambda.mjs"

    content = <<-JS
      export const handler = awslambda.streamifyResponse(async (_event, responseStream) => {
        const stream = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: 503,
          headers: { "content-type": "application/json" },
        });
        stream.write(JSON.stringify({ error: "Bootstrap placeholder — run the Deploy workflow to publish the agent bundle." }));
        stream.end();
      });
    JS
  }
}

resource "aws_cloudwatch_log_group" "agent" {
  name              = "/aws/lambda/${var.project_name}-agent"
  retention_in_days = 30
}

resource "aws_iam_role" "agent_lambda" {
  name = "${var.project_name}-agent-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "agent_lambda_logs" {
  role       = aws_iam_role.agent_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Read-only access to this app's SSM Parameter Store prefix only.
resource "aws_iam_role_policy" "agent_lambda_ssm" {
  name = "${var.project_name}-agent-ssm-read"
  role = aws_iam_role.agent_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameters"]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com"
          }
        }
      },
    ]
  })
}

resource "aws_lambda_function" "agent" {
  function_name    = "${var.project_name}-agent"
  role             = aws_iam_role.agent_lambda.arn
  runtime          = "nodejs22.x"
  architectures    = ["x86_64"]
  handler          = "dist/lambda.handler"
  memory_size      = var.lambda_memory_mb
  timeout          = var.lambda_timeout_seconds
  publish          = true
  filename         = data.archive_file.bootstrap.output_path
  source_code_hash = data.archive_file.bootstrap.output_base64sha256

  environment {
    variables = {
      NODE_ENV              = "production"
      HOME                  = "/tmp"
      RAW_DATA_ROOT         = "/tmp/raw_data"
      DUCKDB_PATH           = "/var/task/data/financial_engine.db"
      RETRIEVAL_MODE        = "local"
      AGENT_MODEL           = var.agent_model
      AUTH_MODE             = "cognito"
      COGNITO_USER_POOL_ID  = aws_cognito_user_pool.main.id
      COGNITO_CLIENT_ID     = aws_cognito_user_pool_client.web.id
      DEMO_USERNAME         = var.demo_username
      SSM_PREFIX            = "/${var.project_name}"
      ORIGIN_VERIFY_SECRET  = random_password.origin_verify.result
      TURNS_PER_HOUR        = tostring(var.turns_per_hour)
      USER_TOKENS_PER_DAY   = tostring(var.user_tokens_per_day)
      GLOBAL_TOKENS_PER_DAY = tostring(var.global_tokens_per_day)
    }
  }

  depends_on = [aws_cloudwatch_log_group.agent]

  # GitHub Actions publishes each commit SHA's bundle from S3 and updates the
  # `live` alias below; Terraform must not overwrite deployed code on apply.
  lifecycle {
    ignore_changes = [filename, source_code_hash, s3_bucket, s3_key]
  }
}

# Stable alias pointed at the latest smoke-tested Lambda version. On a failed
# post-deploy smoke test, deploy.yml flips this alias back to the previous
# version in one API call.
resource "aws_lambda_alias" "live" {
  name             = "live"
  function_name    = aws_lambda_function.agent.function_name
  function_version = aws_lambda_function.agent.version

  lifecycle {
    ignore_changes = [function_version]
  }
}

# Public Function URL fronted by CloudFront. Direct callers without
# CloudFront's X-Origin-Verify header get a 403 inside the Hono middleware;
# using NONE + shared header avoids CloudFront OAC's SigV4 x-amz-content-sha256
# restriction on POST bodies while keeping SSE streaming native.
resource "aws_lambda_function_url" "agent" {
  function_name      = aws_lambda_function.agent.function_name
  qualifier          = aws_lambda_alias.live.name
  authorization_type = "NONE"
  invoke_mode        = "RESPONSE_STREAM"
}

# AWS's dual-permission Function URL model requires both InvokeFunctionUrl and
# InvokeFunction on the alias resource policy.
resource "aws_lambda_permission" "function_url" {
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.agent.function_name
  qualifier              = aws_lambda_alias.live.name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "function_url_invoke" {
  statement_id  = "FunctionURLInvokeAllowPublicAccess"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent.function_name
  qualifier     = aws_lambda_alias.live.name
  principal     = "*"
}
