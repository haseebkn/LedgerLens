# Reviewer guide: Financial Context Engine

## The project in 30 seconds

I built a financial context agent that combines transaction, brokerage, and calendar data behind a React/TypeScript chat interface. The Node.js agent chooses among semantic search, guarded SQL, and deterministic financial tools. Its execution traces, citation checks, and evaluation harness make the failure modes inspectable. Live use led to changes in tool selection, aggregate attribution, refusal behavior, and evaluation rules.

The strongest evidence is the iteration record: the agent produced plausible but incomplete answers, the harness sometimes rewarded the wrong behavior, and both needed correction. The project is a locally exercised, single-user portfolio prototype. It does not claim customer adoption or production-scale reliability.

## Why it is relevant to Verlo

The [Software Developer posting](https://jobs.ashbyhq.com/verlo/96a30e37-d08b-4c72-99cd-bae43ffcfb12) emphasizes ownership across React, TypeScript, Node.js and AWS, agent workflows, evaluation, observability, and effective use of coding agents.

| Area | Inspectable evidence |
|---|---|
| End-to-end product work | [React chat and dashboard](../web/src/), [HTTP/SSE service](../agent/src/index.ts), [Python retrieval](../vector_prep/retrieval_service.py) |
| Agent reliability | [Bounded agent loop](../agent/src/agent-loop.ts), [SQL guard](../agent/src/lib/sql-guard.ts), [citation provenance](../agent/src/lib/citations.ts), regression tests beside each component |
| Evaluation judgment | [Historical 34-case report](../agent/evals/reports/2026-08-26T01-34-34-845Z.md), [scorers and measurement definitions](../agent/evals/README.md) |
| Observability | [Span events](../agent/src/streaming-types.ts), [trace persistence](../agent/src/lib/trace-writer.ts), [warehouse metrics](../agent/src/lib/metrics.ts) |
| Data correctness | dbt source reconciliation, deleted-vector cleanup, and date-filter regressions described in [the audit](AUDIT.md) |
| AWS design | [ECS/EFS/ALB Terraform](../infra/aws/README.md), containers, CI validation; a running deployment is not claimed |
| AI-assisted development | [Engineering notes](../README.md#building-with-coding-agents): generated implementations checked against executable behavior and real failures |

This is an independent project prepared for a job application; it is not a Verlo product or integration.

## A five-minute walkthrough

1. Show an aggregation question such as “How much did I spend by category?” Explain the sign convention and show the computed-result citation. The tool trace should reveal the query that produced the numbers.
2. Ask an activity question such as “Did I go rock climbing?” Explain why calendar events and transactions are different evidence, and why recurring charges alone cannot prove a visit or membership.
3. Ask “Should I buy more AAPL?” Show the refusal boundary. A passing no-tool check alone cannot establish a correct refusal, so the evaluation also grades the answer.
4. Open Metrics. Explain token costs, prompt-cache usage, error rate, and latency. Metrics reflect persisted traces after a dbt refresh, rather than an automatically updating event store.
5. Open Evals. Show the historical results, a judge disagreement, and the measurement caveats below. Finish with one regression from [the audit](AUDIT.md) and its test.

Use a reviewed demo dataset or a private local session for the walkthrough. The public golden set depends on the original local data; it will not reproduce the published scores against the tiny CI fixtures.

## Reviewing without API credentials

The committed reports, screenshots, source, and CI workflow can be reviewed on GitHub without installing anything. For executable checks, Node 22.12+ and Python 3.11 are the supported starting point.

Build a separate synthetic fixture warehouse, leaving any existing personal database intact. From the repository root on macOS/Linux:

```bash
npm ci
python -m pip install dbt-duckdb
mkdir -p .demo
export RAW_DATA_ROOT="$PWD/tests/fixtures/raw"
export DUCKDB_PATH="$PWD/.demo/financial_engine.db"
dbt build --project-dir transform --profiles-dir transform --full-refresh
npm test
npm run typecheck
npm run build
```

PowerShell equivalents for the setup before `dbt build`:

```powershell
New-Item -ItemType Directory -Force .demo | Out-Null
$env:RAW_DATA_ROOT = (Resolve-Path tests/fixtures/raw).Path
$env:DUCKDB_PATH = Join-Path (Get-Location) '.demo/financial_engine.db'
```

Keep those environment variables in the same terminal for `npm test`. These Node tests use fixture data, scripted model responses, and mocked retrieval; they incur no Anthropic charges. Python tests need the development dependencies documented in the root README and CI. The fixture warehouse alone does not populate a semantic vector store or enable a live chat.

## What the evaluation numbers mean

- The August 26 report contains 34 cases and predates this audit. Its 100% tool-choice and recall scores are narrow test-set results, not a universal accuracy estimate.
- The recorded $0.4771 covers estimated agent tokens only. Three judge calls per case incurred additional usage that this historical report did not record.
- Historical case latency includes judging. New runs measure agent time separately and label the cost scope.
- Matching case counts are insufficient for a before/after comparison. New reports fingerprint the golden set and record scoring version and judge sample count. Legacy reports cannot establish a controlled comparison with the corrected harness.
- Citation identifier validation establishes observed provenance, not semantic truth. An LLM judge is fallible; the retained manual adjudication illustrates that limitation.
- Public reports remove selected raw fields, but questions and judge explanations still need human privacy review before publication.

## Application description

> Built a React/TypeScript and Node.js financial context agent over Plaid, Alpaca, and calendar data, with guarded SQL, semantic retrieval, citation provenance, and per-turn cost and latency traces. Evaluated it on 34 local cases and used observed failures to refine tool selection and scoring. A subsequent audit added regressions for SQL access boundaries, deletion propagation, streaming cancellation, and misleading evaluation comparisons. AWS deployment configuration is included; the project is demonstrated locally.

The next strongest evidence would be a short recorded walkthrough and a fresh full evaluation on the audited code. A low-cost public demo is a separate deployment step requiring access control and a reviewed dataset.
