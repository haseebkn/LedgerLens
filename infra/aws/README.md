# AWS Deployment — Always-Free Serverless (Terraform)

Deploys LedgerLens on AWS at **~$0/month permanently**, even on an older AWS account with no free-tier credits, using AWS's **Always Free** serverless services.

## Architecture

```text
Internet (HTTPS — free https://<id>.cloudfront.net URL, or optional custom domain)
   │
   ▼
Amazon CloudFront (Always Free: 1 TB/mo + 10M reqs/mo + security headers policy)
   ├── /api/*  ──▶  AWS Lambda Function URL (Node.js 22, RESPONSE_STREAM for real SSE)
   │                   ├── X-Origin-Verify header check (blocks direct Function URL calls)
   │                   ├── Cognito JWT verification + per-user / daily limits
   │                   ├── Read-only DuckDB synthetic warehouse (/var/task/data/financial_engine.db)
   │                   ├── In-process Node search (RETRIEVAL_MODE=local — no 3 GiB Python container)
   │                   └── Cold-start secret fetch from SSM Parameter Store (Standard SecureStrings)
   └── /*      ──▶  Private S3 bucket via CloudFront OAC (+ SPA rewrite CloudFront Function)
```

### Why serverless instead of ECS Fargate?

An always-on ECS Fargate + ALB + WAF stack costs ~$110/month even with zero traffic. This stack delivers the same security and streaming properties at **~$0/month**:

| Service | Always-Free allowance (works on old AWS accounts) | Estimated monthly cost |
| :--- | :--- | :--- |
| **CloudFront** | 1 TB transfer + 10M HTTP/S requests + 2M CloudFront Function invocations + 1,000 invalidations | **$0.00** |
| **AWS Lambda** | 1M requests + 400,000 GB-seconds (~111 hours/mo at 1024 MiB) | **$0.00** |
| **Amazon Cognito** | 10,000+ monthly active users | **$0.00** |
| **SSM Parameter Store** | Standard parameters & API calls | **$0.00** |
| **CloudWatch Logs** | 5 GB ingestion & archival | **$0.00** |
| **Amazon S3 + DynamoDB** | Tiny static SPA (~1 MB), SHA Lambda zips (30-day expiry), TF state | **< $0.05** |

Your only real cost is Anthropic API usage from demo visitors, bounded by:
1. Per-turn working-token cap in the agent loop
2. Per-user hourly turn limit (`20/hr`) and daily token cap (`300k/day`) + global daily token cap (`3M/day`)
3. A **monthly spend limit** you set in the Anthropic Console (Settings → Limits) — set this first (e.g. $5/month).

*(Note: in-process rate-limit counters live per warm Lambda container; Phase 3 moves counters, traces, and multi-advisor data to free-tier Neon Postgres + pgvector with row-level security.)*

## What's deployed vs. what isn't

* **Deployed:** Static React SPA on S3/CloudFront, Node.js 22 streaming Claude agent on Lambda with the deterministic synthetic DuckDB warehouse baked into each SHA-tagged release zip, public eval reports, Cognito auth + "Try the demo", and in-process retrieval (`RETRIEVAL_MODE=local`).
* **Not deployed:** The live Plaid/Alpaca/Google Calendar extractors, Airflow DAG, and the 3 GiB Python ChromaDB/PyTorch retrieval container (kept for local `make demo` and data-engineering workflows).
* **Metrics tab:** Lambda writes turn traces to `/tmp/raw_data` (ephemeral); live deployed metrics arrive in Phase 5 via OpenTelemetry + Postgres.

## One-time AWS Setup

### 1. Remote Terraform state (S3 + DynamoDB lock)

```bash
cd infra/aws/bootstrap
terraform init && terraform apply          # prints state_bucket and lock_table
```

### 2. Provision the serverless stack

```bash
cd ../                                     # infra/aws
cp backend.hcl.example backend.hcl         # fill in state_bucket; gitignored
cp terraform.tfvars.example terraform.tfvars
# Review terraform.tfvars:
# - Leave domain_name = "" to use CloudFront's free https://<id>.cloudfront.net URL.
# - Set github_repo = "haseebkn/LedgerLens" to auto-create the OIDC deploy role
#   (set create_github_oidc_provider = true if this AWS account doesn't have GitHub OIDC yet).
terraform init -backend-config=backend.hcl
terraform apply
```

### 3. Store secrets in SSM Parameter Store & create the demo Cognito user

Secrets are **never** Terraform variables and never enter Terraform state. Run once after `terraform apply`:

```bash
POOL=$(terraform output -raw cognito_user_pool_id)
PREFIX=$(terraform output -raw ssm_prefix)          # /financial-context
DEMO_PASSWORD='<at least 14 characters, upper + lower case + a number>'

# Store ANTHROPIC_API_KEY and DEMO_PASSWORD as Always-Free Standard SecureStrings
aws ssm put-parameter --name "${PREFIX}/anthropic-api-key" --type SecureString --value "$ANTHROPIC_API_KEY" --overwrite
aws ssm put-parameter --name "${PREFIX}/demo-password"     --type SecureString --value "$DEMO_PASSWORD"     --overwrite

# Create the shared "Try the demo" user in Cognito
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username demo --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username demo --password "$DEMO_PASSWORD" --permanent
```

Set a monthly spend limit on your Anthropic workspace in the Anthropic Console before sharing the URL.

### 4. Configure GitHub Actions & run the first deploy

Add these settings under **GitHub → Repository Settings → Secrets and variables → Actions** using `terraform output`:

* **Secret:** `AWS_ROLE_ARN` = `terraform output -raw github_deploy_role_arn`
* **Variables:**
  * `DEPLOY_ENABLED` = `true`
  * `APP_URL` = `terraform output -raw app_url`
  * `WEB_BUCKET` = `terraform output -raw web_bucket`
  * `ARTIFACTS_BUCKET` = `terraform output -raw artifacts_bucket`
  * `LAMBDA_FUNCTION_NAME` = `terraform output -raw lambda_function_name`
  * `CLOUDFRONT_DISTRIBUTION_ID` = `terraform output -raw cloudfront_distribution_id`

Then trigger **Actions → Deploy to AWS → Run workflow** once (every subsequent merge to `main` that passes CI deploys automatically by commit SHA, with automatic alias rollback if `scripts/smoke/smoke.mjs` fails).

## Optional: Adding a Free Custom Domain Later

If you later claim a free domain (e.g. via the GitHub Student Developer Pack or a free subdomain provider supporting CNAME records):

1. Set `domain_name = "ledgerlens.yourdomain.me"` in `terraform.tfvars` and run `terraform apply`.
2. Add the DNS validation CNAME printed by `terraform output certificate_validation_records` at your DNS registrar (ACM issues the cert in `us-east-1` automatically).
3. Point `domain_name` (CNAME) at `terraform output -raw cloudfront_domain_name`.
4. Update the GitHub `APP_URL` variable to `https://ledgerlens.yourdomain.me`.

## Tearing Down

```bash
# Empty the S3 buckets first, then destroy the stack
aws s3 rm "s3://$(terraform output -raw web_bucket)" --recursive
aws s3 rm "s3://$(terraform output -raw artifacts_bucket)" --recursive
terraform destroy
```
