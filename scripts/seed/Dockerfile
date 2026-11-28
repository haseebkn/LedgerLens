# syntax=docker/dockerfile:1
# Builds the synthetic demo warehouse (scripts/seed/generate.py + dbt) into
# /out/financial_engine.db. The agent and retrieval images copy it into
# their `demo` targets, so the demo needs no data-loading step anywhere:
#
#   docker build -f scripts/seed/Dockerfile -t ledgerlens-warehouse:demo .
#   docker build -f agent/Dockerfile --target demo \
#     --build-context warehouse=docker-image://ledgerlens-warehouse:demo -t ledgerlens-agent:demo .
#
# docker-compose.yml wires the same thing with `additional_contexts`.
FROM python:3.11-slim
WORKDIR /repo

# dbt and DuckDB versions come from requirements.txt, the single place they
# are pinned (DuckDB must match the agent's @duckdb/node-api file format).
COPY requirements.txt requirements.txt
RUN grep -E '^(dbt-core|dbt-duckdb|duckdb)==' requirements.txt > /tmp/dbt-requirements.txt \
    && pip install --no-cache-dir -r /tmp/dbt-requirements.txt

COPY scripts/seed/generate.py scripts/seed/generate.py
COPY transform/ transform/

# The last day of synthetic data. Fixed by default so eval answers are
# stable; set it near today if you want "last month" to have data.
ARG SEED_END_DATE=2026-11-30
RUN python scripts/seed/generate.py --out /repo/.demo/raw_data --end-date "${SEED_END_DATE}"

WORKDIR /repo/transform
RUN mkdir -p /out \
    && RAW_DATA_ROOT=/repo/.demo/raw_data DUCKDB_PATH=/out/financial_engine.db \
       dbt build --full-refresh --profiles-dir . \
    && rm -rf target logs
