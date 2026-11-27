# AWS Deployment (Terraform)

Deploys the three containers built by [`agent/Dockerfile`](../../agent/Dockerfile), [`web/Dockerfile`](../../web/Dockerfile), and [`vector_prep/Dockerfile`](../../vector_prep/Dockerfile) onto ECS Fargate, behind one public ALB.

## Architecture

```
Internet
   │
   ▼
ALB (port 80)
   ├── /api/*  ──▶  agent Fargate service (port 8787) ──▶  retrieval Fargate service (port 8100, internal-only via Cloud Map)
   └── /*      ──▶  web Fargate service (nginx, port 80)

agent + retrieval both mount an EFS access point:
   agent      ──▶  /data           (financial_engine.db, read-only DuckDB queries)
   retrieval  ──▶  /repo/vector_store  (ChromaDB persistence)
```

- **No NAT gateway.** Fargate tasks run in public subnets with public IPs and security-group-restricted ingress, saving the ~$32/mo a NAT gateway would cost. This is a reasonable trade for a single-service portfolio deploy — not a pattern to copy for a workload handling real financial data.
- **No RDS.** The warehouse is a DuckDB file on EFS, matching how it already runs locally — one writer (dbt/the extractors, run out-of-band, not deployed here), many readers (the agent's tools).
- **No HTTPS by default.** The ALB listens on port 80 only. Point a domain at `alb_dns_name`, request an ACM certificate, and add a port-443 listener before this serves anything beyond a demo.

## What's deployed vs. what isn't

Terraform here provisions the **serving path**: the agent's chat API, the retrieval service, and the web frontend. It does **not** run the ingestion pipeline (`extract/`), dbt builds, or the embedding backfill (`vector_prep/embed_context.py`) — those populate `financial_engine.db` and the ChromaDB store, which then need to land on the EFS volumes this stack creates (e.g. via a one-off `aws efs` mount from a bastion, or a scheduled ECS task — not included, since running the actual ingestion against live brokerage/bank APIs from a shared cloud environment is a separate decision from standing up the serving infrastructure).

Agent traces are written to `/data/raw_data/agent_traces` on the warehouse EFS access point so task replacement does not discard them. An out-of-band dbt build must ingest those files before Metrics reflects new traffic. Public evaluation reports ship in the agent image; private and partial reports are excluded from the Docker build context.

The HTTP API has no user authentication or monthly usage cap. Before exposing it publicly, use reviewed synthetic data, add access control and TLS, and enforce an API spending policy. Local container checks and Terraform validation do not establish that this stack has operated successfully on AWS.

## Setup

```bash
cd infra/aws
terraform init
cp terraform.tfvars.example terraform.tfvars   # fill in real secrets, don't commit it
terraform plan
terraform apply
```

Requires AWS credentials in the environment (`aws configure`, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) with permissions to create VPC, ECS, ECR, EFS, ALB, IAM, Secrets Manager, Cloud Map, and CloudWatch Logs resources.

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
