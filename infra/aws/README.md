# AWS Deployment (Terraform)

Deploys the three containers built by [`agent/Dockerfile`](../../agent/Dockerfile), [`web/Dockerfile`](../../web/Dockerfile), and [`vector_prep/Dockerfile`](../../vector_prep/Dockerfile) onto ECS Fargate, behind one public ALB.

## Architecture

```
Internet
   │
   ▼
ALB (HTTPS 443 with ACM certificate; port 80 redirects; WAF rate limits)
   ├── /api/*  ──▶  agent Fargate service (port 8787) ──▶  retrieval Fargate service (port 8100, internal-only via Cloud Map)
   └── /*      ──▶  web Fargate service (nginx, port 80)

Data, by default baked into the images' demo targets (data_source = "baked_demo"):
   agent      ──▶  /data/financial_engine.db   (synthetic warehouse, read-only DuckDB)
   retrieval  ──▶  /repo/vector_store          (ChromaDB store embedded at build time)
With data_source = "efs", both paths are EFS access points instead (agent read-only).
```

- **No NAT gateway.** Fargate tasks run in public subnets with public IPs and security-group-restricted ingress, saving the ~$32/mo a NAT gateway would cost. This is a reasonable trade for a single-service portfolio deploy — not a pattern to copy for a workload handling real financial data.
- **No RDS yet.** The warehouse is a DuckDB file, baked into the demo image or on EFS — one writer (dbt, out of band), many readers (the agent's tools). Phase 3 moves serving data to Postgres.
- **HTTPS only.** The ALB serves `domain_name` with an ACM certificate (TLS 1.2+); port 80 returns a 301 to HTTPS. A WAF on the ALB limits requests per IP, with a tighter limit on the demo sign-in.
- **Sign-in in the app.** The agent verifies Cognito access tokens on every `/api/*` route except health, readiness and sign-in discovery, and enforces per-user turn and token limits (`agent/src/lib/auth.ts`, `agent/src/lib/usage-limits.ts`).

## What's deployed vs. what isn't

Terraform here provisions the **serving path**: the agent's chat API, the retrieval service, and the web frontend. It does **not** run the ingestion pipeline (`extract/`), dbt builds, or the embedding backfill (`vector_prep/embed_context.py`). The default deployment needs none of them: it serves the synthetic data baked into the demo images. Serving real data means `data_source = "efs"` and loading `financial_engine.db` and the ChromaDB store onto EFS yourself; that path is not automated, since running live brokerage and bank ingestion from a shared cloud environment is a separate decision.

Agent traces are written to the agent container's own disk (`/repo/raw_data`), so a task replacement discards them and the deployed Metrics tab does not update; Phase 5 replaces file traces with OpenTelemetry export. Public evaluation reports ship in the agent image; private and partial reports are excluded from the Docker build context.

Spend controls, from inside out: a per-turn token budget in the agent loop; per-user limits (default 20 turns per hour and 300k tokens per day); a global 3M tokens per day; the WAF's per-IP limits; and a monthly spend limit you set on the Anthropic workspace that owns the key (Console → Settings → Limits). Set that last one before sharing the URL: it is the only one that holds if everything else is misconfigured. Terraform validation in CI does not establish that this stack has run on AWS.

## Setup

State lives in S3 with a DynamoDB lock. Create both once:

```bash
cd infra/aws/bootstrap
terraform init && terraform apply          # prints state_bucket and lock_table
```

Then, from `infra/aws`:

```bash
cp backend.hcl.example backend.hcl            # fill in state_bucket; not committed
cp terraform.tfvars.example terraform.tfvars  # domain_name etc.; holds no secrets
terraform init -backend-config=backend.hcl
terraform apply
```

Secrets are never Terraform variables, so they never enter state. After the first apply, set their values (and the demo password, below):

```bash
aws secretsmanager put-secret-value --secret-id financial-context/anthropic-api-key --secret-string "$ANTHROPIC_API_KEY"
aws secretsmanager put-secret-value --secret-id financial-context/retrieval-service-token --secret-string "$(openssl rand -hex 32)"
```

Upgrading from a version that took `anthropic_api_key` and `retrieval_service_token` as variables: the `removed` blocks in `secrets.tf` make Terraform forget those secret versions without deleting them. The old local state still contains both values, so rotate them and delete the old state file.

### Data

By default (`data_source = "baked_demo"`) the agent and retrieval services run their images' `demo` targets, which carry the synthetic warehouse and vector store built from `scripts/seed/`. Nothing is mounted and EFS is not created. With `data_source = "efs"` the default targets run and mount EFS instead (the agent read-only); loading data onto it is up to you.

Each service has its own task role. With baked data neither has any AWS permissions; with EFS the agent may only mount its access point read-only and retrieval may write only through its own.

Requires AWS credentials in the environment (`aws configure`, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) with permissions to create VPC, ECS, ECR, ALB, ACM, WAF, Cognito, IAM, Secrets Manager, Cloud Map and CloudWatch Logs resources (plus EFS with `data_source = "efs"`, and Route 53 records with `route53_zone_id`).

## Domain, sign-in and the demo account

1. **Domain.** Set `domain_name`. If its DNS is a Route 53 hosted zone, also set `route53_zone_id` and Terraform creates the certificate validation and alias records. Otherwise `terraform apply` waits on the certificate: add the record from the `certificate_validation_records` output at your DNS provider, and afterwards point `domain_name` at `alb_dns_name`.
2. **Secrets.** Terraform creates the demo-password secret without a value, so the password never enters state. Set it, and create the matching Cognito user, before the first deploy (an ECS task can't start with an empty secret):

```bash
POOL=$(terraform output -raw cognito_user_pool_id)
DEMO_PASSWORD='<at least 14 characters, upper and lower case and a number>'
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username demo --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username demo --password "$DEMO_PASSWORD" --permanent
aws secretsmanager put-secret-value --secret-id financial-context/demo-password --secret-string "$DEMO_PASSWORD"
```

3. **Spend limit.** Set a monthly limit on the Anthropic workspace that owns the API key.

Other accounts are created the same way (`admin-create-user`); there is no self sign-up, and the web app currently offers only "Try the demo".

## Building and pushing images

```bash
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com

docker build -f agent/Dockerfile -t <account-id>.dkr.ecr.us-east-1.amazonaws.com/financial-context/agent:latest .
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/financial-context/agent:latest

docker build -f web/Dockerfile -t <account-id>.dkr.ecr.us-east-1.amazonaws.com/financial-context/web:latest .
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/financial-context/web:latest

docker build -f vector_prep/Dockerfile -t <account-id>.dkr.ecr.us-east-1.amazonaws.com/financial-context/retrieval:latest .
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/financial-context/retrieval:latest
```

Then force a new deployment so the running services pick up the new image:

```bash
aws ecs update-service --cluster financial-context-cluster --service financial-context-agent --force-new-deployment
aws ecs update-service --cluster financial-context-cluster --service financial-context-web --force-new-deployment
aws ecs update-service --cluster financial-context-cluster --service financial-context-retrieval --force-new-deployment
```

See [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) for a CI workflow that automates the build/push/redeploy steps on manual dispatch.

## Cost

At the default sizing, the three tasks reserve 1.75 vCPU and 4.5 GiB total. Using 730 hours/month and US East (N. Virginia) Linux/x86 on-demand rates, compute is about **$66.32/month**. The ALB base adds **$16.43**, and five public IPv4 addresses (three tasks plus an assumed two ALB nodes) add **$18.25**. That is roughly **$101/month before** storage, logs, secrets, traffic, taxes, and Anthropic usage. This is an estimate, not a bill; verify the region and actual resources before deployment. Sources: [Fargate](https://aws.amazon.com/fargate/pricing/), [ALB](https://aws.amazon.com/elasticloadbalancing/pricing/), [public IPv4](https://aws.amazon.com/vpc/pricing/).

Scaling tasks to zero does not remove the ALB or its IPv4 charges. A target near $5/month requires a different hosting design, usually a backend that sleeps when idle; that migration is not implemented in this Terraform stack.

## Tearing down

```bash
terraform destroy
```
