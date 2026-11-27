# Agent Service

A Node/TypeScript service that puts an LLM agent in front of the financial context warehouse, with tools for searching, querying, and aggregating data and checks for observed citation provenance.

## Architecture

```
Browser / client
      │  POST /api/chat (SSE)
      ▼
agent/ (Node, Hono)  ──HTTP──▶  vector_prep/retrieval_service.py (Python, FastAPI)
      │                              │
      │  DuckDB (read-only)          │  ChromaDB + sentence-transformers
      ▼                              ▼
financial_engine.db            vector_store/
```

The Python side stays Python (ChromaDB and sentence-transformers have no reason to move); the Node side owns the LLM loop, the SQL-generation tool, and the HTTP API. See `sql-guard.ts`'s header comment for why `query_warehouse` needs its own validation layer even though the DuckDB connection is opened read-only.

## Tools

| Tool | Purpose |
|---|---|
| `search_context` | Semantic search over calendar/Plaid/Alpaca narrative rows, via the retrieval service |
| `query_warehouse` | Freeform read-only SQL, validated by `lib/sql-guard.ts` (single-statement SELECT, table allowlist, banned-function blocklist, LIMIT enforcement) |
| `get_portfolio_snapshot` | Fixed query: latest account balance + 5 most recent trades |
| `summarize_spend` | Fixed aggregation: spend/income totals by category or time bucket |

`get_portfolio_snapshot` and `summarize_spend` are deliberately not left to freeform SQL — the arithmetic that matters most for a financial answer should be tested code with a documented sign convention, not regenerated per call.

The freeform SQL tool requires allowed schema-qualified tables, permits scoped non-recursive CTEs and SELECT subqueries, and rejects dynamic table functions and recursive CTEs. Its row cap is not an execution-time or CPU sandbox.

## Setup

```bash
cd agent
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY and RETRIEVAL_SERVICE_TOKEN
```

`RETRIEVAL_SERVICE_TOKEN` must match the same value set in the repo root `.env` (read by `config/settings.py`).

## Running

Requires the retrieval service running first (from the repo root):

```bash
# Terminal 1 — retrieval service
uvicorn vector_prep.retrieval_service:app --host 127.0.0.1 --port 8100

# Terminal 2 — agent service
cd agent
npm run dev
```

Then:

```bash
curl -N -X POST http://localhost:8787/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "How much did I spend on coffee last month?"}'
```

Streams Server-Sent Events per `src/streaming-types.ts` — `text_delta`, `thinking_delta`, `span_start`/`span_end` (llm_call / tool_exec / citation_validation, with per-call token usage on llm_call spans — this is the waterfall data), `tool_call`, `tool_result`, `citation`, `text_correction` (issued if citation repair rewrites the answer after it already streamed), `error`, `done`.

## Observability

Every completed turn writes a trace record to `raw_data/agent_traces/<date>/*.json`, following the same landing-zone envelope pattern as the extractors (`src/lib/trace-writer.ts`). A dbt staging + mart model (`stg_agent_traces` → `fct_agent_traces`, materialized as a table) reads them into the warehouse — it degrades gracefully to an empty, correctly-typed table if no traces exist yet (a fresh clone, or before the agent has ever handled a request), rather than breaking `dbt build`.

```bash
curl http://localhost:8787/api/metrics
curl http://localhost:8787/api/traces/<trace_id>
```

`/api/metrics` returns turns/day, mean iterations, repair rate, error rate, total cost, p50/p95 latency, cache-hit rate, and the tool-call distribution — all computed by real SQL against `fct_agent_traces`, not pre-aggregated at write time. Run `dbt build` after generating some traffic to pick up new trace files.

If a turn fails before `done`, the trace preserves usage from completed model spans. Any unreported in-flight usage remains unknown, so failed-turn costs and measured durations are lower bounds. Cache-hit rate includes fresh, cache-created, and cache-read input tokens in its denominator.

## Testing

```bash
npm run typecheck
npm test
```

The DuckDB-backed tool tests use a read-only warehouse connection. CI builds that warehouse from synthetic fixtures. Route and agent-loop tests use deterministic service doubles and never need live model calls. Network smoke tests require explicit `RUN_NETWORK_SMOKE=1`; the committed eval reports are the evidence for the real Anthropic path.

## Live evaluation

The live Anthropic path has been exercised against the populated warehouse. The August 26 baseline runs 34 cases on `claude-sonnet-5` with three judge samples per case: 100% tool-choice accuracy, 100% retrieval recall, and 4.86/5 mean judge score. Its $0.4771 estimate covers agent usage only, excluding judge calls; historical latency includes judge execution. These results predate the current audit and pricing changes. Run `npm run eval -- --gate`; see [`evals/README.md`](evals/README.md) for measurement semantics, privacy review, and gate thresholds.

## Request limits and cancellation

Chat accepts up to 8,000 characters per message, 40 history entries, 64,000 combined text characters, and 128 KiB per JSON body. The frontend retains recent complete conversation turns within these bounds. Stop or disconnect aborts active model streaming; an already-running native SQL query finishes normally. These per-request bounds are not a monthly spend limit or public authentication system.

The local service binds to `127.0.0.1` by default. The Docker image explicitly uses `HOST=0.0.0.0` for container networking; publish local demo ports on loopback and configure authentication before exposing them publicly.
