import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";

let database: DuckDBInstance;

// Run the production lookups against a synthetic in-memory warehouse.
async function query(sql: string, values: (string | number | boolean | null)[] = []) {
  const connection = await database.connect();
  try {
    return (await connection.runAndReadAll(sql, values)).getRowObjectsJson() as Record<string, unknown>[];
  } finally {
    connection.closeSync();
  }
}
vi.mock("./duckdb.js", () => ({ queryRowsParams: query }));
import { getRowById, snapshotStamp } from "./rows.js";
import { clearComputedResults, getComputedResult, rememberComputedResult } from "./result-store.js";

beforeAll(async () => {
  database = await DuckDBInstance.create(":memory:");
  await query(`
    CREATE SCHEMA main_analytics;
    CREATE TABLE main_analytics.fct_context_rows (
      row_id VARCHAR, source VARCHAR, event_timestamp TIMESTAMP, summary_text VARCHAR, raw_payload VARCHAR
    );
    INSERT INTO main_analytics.fct_context_rows VALUES
      ('plaid_tx1', 'plaid', '2026-03-02 00:00:00', 'Coffee at Bean Co', '{"merchant_name":"Bean Co","amount":4.5,"category":"Food and Drink"}');
    CREATE TABLE main_analytics.dim_account_snapshot (
      account_id VARCHAR, status VARCHAR, cash DOUBLE, equity DOUBLE, portfolio_value DOUBLE,
      buying_power DOUBLE, long_market_value DOUBLE, short_market_value DOUBLE, extracted_at TIMESTAMP
    );
    INSERT INTO main_analytics.dim_account_snapshot VALUES
      ('acct-1', 'ACTIVE', 100000, 100000, 100000, 200000, 0, 0, '2026-03-01 12:00:00'),
      ('acct-1', 'ACTIVE', 99000, 99000, 99000, 198000, 0, 0, '2026-02-01 12:00:00');
  `);
});
beforeEach(() => clearComputedResults());
afterAll(() => database?.closeSync());

describe("getRowById", () => {
  it("returns a source row with its parsed payload", async () => {
    expect(await getRowById("plaid_tx1")).toMatchObject({
      kind: "source", source: "plaid", summaryText: "Coffee at Bean Co",
      payload: { merchant_name: "Bean Co", amount: 4.5 },
    });
  });

  it("returns the exact account snapshot a synthesized alpaca_account id names", async () => {
    const [latest] = await query("SELECT extracted_at FROM main_analytics.dim_account_snapshot ORDER BY extracted_at DESC LIMIT 1");
    const rowId = `alpaca_account_acct-1_${snapshotStamp(latest!["extracted_at"])}`;
    expect(await getRowById(rowId)).toMatchObject({ kind: "account_snapshot", snapshot: { cash: 100000 } });
  });

  it("returns a remembered computed result with its SQL and rows", async () => {
    rememberComputedResult({ resultId: "computed_query_abc", kind: "query", sql: "SELECT 1", rows: [{ total: 12 }] });
    expect(await getRowById("computed_query_abc")).toMatchObject({
      kind: "computed", resultKind: "query", sql: "SELECT 1", rows: [{ total: 12 }],
    });
  });

  it("returns null for unknown, malformed or injection-shaped ids", async () => {
    expect(await getRowById("plaid_missing")).toBeNull();
    expect(await getRowById("computed_query_forgotten")).toBeNull();
    expect(await getRowById("plaid_x' OR '1'='1")).toBeNull();
    expect(await getRowById("secret_table")).toBeNull();
  });
});

describe("computed result store", () => {
  it("expires entries after an hour", () => {
    rememberComputedResult({ resultId: "computed_query_old", kind: "query", sql: "SELECT 1", rows: [] }, 0);
    expect(getComputedResult("computed_query_old", 59 * 60 * 1000)).toBeDefined();
    expect(getComputedResult("computed_query_old", 61 * 60 * 1000)).toBeUndefined();
  });

  it("evicts the oldest entries past its bound", () => {
    for (let i = 0; i < 501; i++) {
      rememberComputedResult({ resultId: `computed_query_${i}`, kind: "query", sql: "SELECT 1", rows: [] });
    }
    expect(getComputedResult("computed_query_0")).toBeUndefined();
    expect(getComputedResult("computed_query_500")).toBeDefined();
  });
});
