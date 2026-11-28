# Portfolio audit

Verified locally on September 8, 2026, starting from commit `f19da10`.

Scope: agent execution and SQL access, HTTP/SSE behavior, React state, Python retrieval and dbt transformations, evaluation integrity, dependency advisories, container packaging, and reviewer-facing claims. This is a source and regression-test audit, not a penetration test or proof of production readiness.

## Findings addressed

| Finding | Change | Regression evidence |
|---|---|---|
| Unqualified tables and dynamic table functions could bypass SQL allowlisting; some limits were ineffective | Inspect query scopes and table expressions; enforce bounded integer limits | `agent/src/lib/sql-guard.test.ts`, `agent/src/tools/query-warehouse.test.ts` |
| SQL/retrieval errors were returned as successful tool text | Propagate errors into the agent's tool error path | Tool tests and `agent/src/agent-loop.test.ts` |
| Cancellation did not stop model streaming; token output was buffered | Consume stream deltas as they arrive and abort model streams on disconnect | Agent-loop and HTTP route tests |
| Blank/unbounded chat input could reach the model; unexpected failures lacked a terminal SSE event | Bound message/history/body size, emit terminal errors, persist cancellation/error traces | `agent/src/index.test.ts` |
| Failed turns lost completed model usage and cache-hit rate omitted cache writes | Recover confirmed span usage when no completion event exists; include cache writes in the denominator | `agent/src/lib/trace-accumulator.test.ts`, `agent/src/lib/metrics.fixture.test.ts` |
| EOF could leave chat permanently loading; tabs discarded conversation state | Detect incomplete streams, retain chat state across tabs, bound recent history | `web/src/hooks/useAgentChat.test.ts`, `web/src/lib/sse.test.ts`, `web/src/App.test.tsx` |
| Removed transactions survived incremental materialization and semantic search | Reconcile source IDs in the mart and prune stale vectors after successful synchronization | `tests/test_dbt_incremental.py`, `tests/test_embed_context.py` |
| Chroma date comparisons used unsupported string range operators | Validate date inputs and apply a supported date filter before similarity ranking | `tests/test_retrieval_service.py` |
| Eval timing included judge execution, judge failures could abort reporting, and matching case counts enabled misleading comparisons | Isolate agent timing, preserve error results, fingerprint scoring inputs, strengthen refusal gate | Eval runner/report/scorer tests |
| Partial evals could replace a full report, and raw errors leaked into public Markdown | Separate partial output and format public summaries from the public projection | Eval CLI/runner tests |
| Packaged agent lacked evaluation reports and a writable trace directory | Include public reports, exclude private artifacts, create a non-root writable directory, persist AWS traces under EFS | Local image build and runtime packaging smoke check |
| Vitest 2 and its transitive dev servers had published vulnerabilities | Upgrade to patched Vitest 3.2.7 and regenerate the lockfile | `npm audit` and workspace test/build checks |
| README overstated deployment status, semantic citation verification, and total eval cost | Separate historical evidence, current verification, and production limitations | [Reviewer guide](PORTFOLIO.md) and root README |

## Verification

Focused HTTP regressions reproduced seven failures before the route fix and pass after it. SQL regressions also reproduced the access/limit failures before their fixes. Tests use isolated fixture state or scripted service doubles; no new paid evaluation or live financial ingestion is part of this audit.

| Check | Result |
|---|---|
| Agent + evaluation unit/integration suite | 213 passed; 2 external-network smoke tests intentionally skipped |
| React/SSE suite | 56 passed |
| Python suite | 73 passed, including real Chroma 0.5.23 collections and repeated isolated dbt builds |
| Reviewer setup recipe | Separate `.demo/financial_engine.db` built successfully: 10 models + 22 dbt tests; all Node tests also pass against this synthetic warehouse |
| TypeScript checks and production builds | Agent and web passed |
| Python quality gates | Ruff lint/format passed on 25 files; mypy passed on 16 source files |
| Web lint | Passed |
| npm dependency audit | 0 known advisories after the Vitest update |
| Final agent container | Built successfully; network-disabled runtime smoke verified public report availability, non-root trace writes, excluded private reports, and omitted dev dependencies |
| Terraform | `fmt -check`, isolated `init -backend=false`, and `validate` passed without AWS credentials or deployment |
| Browser | Confirmed retained chat draft across tabs and rendered historical Evals report with corrected measurement labels; inspected dashboard layout |

The 342 passing Node/Python tests do not include the 22 dbt data tests. The repository's existing GitHub Actions run for `f19da10` was green when checked; these new changes have local verification, not a new remote CI run. No historical report, golden-set score, or personal warehouse was rewritten.

## Remaining boundaries

- The latest published model scores predate these fixes. A fresh paid run is required to report their live effect.
- This is a single-user application. Public deployment still needs access control, TLS, abuse/spend controls, and reviewed data. No deployment or application submission is performed by this audit.
- Native SQL execution is not interrupted mid-query by browser cancellation; row limits do not constitute a CPU/time sandbox.
- Metrics require dbt ingestion of new trace files. Persistence is not real-time aggregation.
- Failed/cancelled turn usage covers confirmed completed model spans. Tokens from an interrupted in-flight request are unknown; recorded failure costs and measured durations are lower bounds.
- Historical reports cannot recover unrecorded judge costs or separate agent-only latency after the fact.
- A small fixture suite does not prove API-provider behavior at scale. Production ingestion, concurrency, and infrastructure operation require separate live verification.
