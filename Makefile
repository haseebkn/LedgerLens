# Convenience targets. Each one is a plain command you can also run yourself.
.PHONY: demo demo-down seed seed-advisor

# Full stack on synthetic data at http://localhost:8080. Needs ANTHROPIC_API_KEY.
demo:
	docker compose up --build

demo-down:
	docker compose down

# Synthetic raw data into .demo/raw_data (then: cd transform && dbt build
# with RAW_DATA_ROOT=../.demo/raw_data DUCKDB_PATH=../.demo/financial_engine.db).
seed:
	python scripts/seed/generate.py --out .demo/raw_data

# Synthetic Phase 3 advisor book (1 firm, 2 advisors, 60 households, ~120 accounts).
seed-advisor:
	python scripts/seed/generate_advisor_book.py --out .demo/advisor_book/book.json
