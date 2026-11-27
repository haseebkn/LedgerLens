data "aws_caller_identity" "current" {}

locals {
  ecs_tasks_assume_role = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role" "ecs_execution" {
  name               = "${var.project_name}-ecs-execution"
  assume_role_policy = local.ecs_tasks_assume_role
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The execution role (pulls images, writes logs) additionally needs to read
# the Secrets Manager secrets so ECS can inject them as task env vars —
# separate from the task roles below, which are what the *application code*
# assumes at runtime.
resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "${var.project_name}-ecs-execution-secrets"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue"]
      Resource = [
        aws_secretsmanager_secret.anthropic_api_key.arn,
        aws_secretsmanager_secret.retrieval_service_token.arn,
        aws_secretsmanager_secret.demo_password.arn,
      ]
    }]
  })
}

# One task role per service, so each gets only what it uses. With the baked
# demo data (data_source = "baked_demo") neither needs any AWS permission.

resource "aws_iam_role" "agent_task" {
  name               = "${var.project_name}-agent-task"
  assume_role_policy = local.ecs_tasks_assume_role
}

resource "aws_iam_role" "retrieval_task" {
  name               = "${var.project_name}-retrieval-task"
  assume_role_policy = local.ecs_tasks_assume_role
}

# The agent only reads the warehouse: mount, never write.
resource "aws_iam_role_policy" "agent_efs_read" {
  count = local.use_efs ? 1 : 0
  name  = "${var.project_name}-agent-efs-read"
  role  = aws_iam_role.agent_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["elasticfilesystem:ClientMount"]
      Resource = aws_efs_file_system.data[0].arn
      Condition = {
        StringEquals = { "elasticfilesystem:AccessPointArn" = aws_efs_access_point.warehouse[0].arn }
      }
    }]
  })
}

# ChromaDB opens its store read-write, so retrieval keeps write access, but
# only through its own access point.
resource "aws_iam_role_policy" "retrieval_efs" {
  count = local.use_efs ? 1 : 0
  name  = "${var.project_name}-retrieval-efs"
  role  = aws_iam_role.retrieval_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
      Resource = aws_efs_file_system.data[0].arn
      Condition = {
        StringEquals = { "elasticfilesystem:AccessPointArn" = aws_efs_access_point.vector_store[0].arn }
      }
    }]
  })
}
