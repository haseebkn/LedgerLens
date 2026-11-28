import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";

let database: DuckDBInstance;

// Only replace the file connection: execute the actual production SQL against
// a synthetic in-memory warehouse so the fraction is verified by DuckDB itself.
async function query(sql: string): Promise<Record<string, unknown>[]> {
  const connection = await database.connect();
  try {
    return (await connection.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
  } finally {
    connection.closeSync();
  }
}
vi.mock("./duckdb.js", () => ({ queryRows: (sql: string) => query(sql) }));
import { getMetrics } from "./metrics.js";

beforeAll(async () => {
  database = await DuckDBInstance.create(":memory:");
  await query(`
    CREATE SCHEMA main_analytics;
    CREATE TABLE main_analytics.fct_agent_traces (
      iterations INTEGER, repaired BOOLEAN, errored BOOLEAN, cost_usd DOUBLE,
      total_duration_ms INTEGER, cache_read_input_tokens BIGINT, input_tokens BIGINT,
      cache_creation_input_tokens BIGINT, tool_calls_json VARCHAR, extracted_at TIMESTAMP
    );
  `);
});
beforeEach(async () => { await query("DELETE FROM main_analytics.fct_agent_traces"); });
afterAll(() => { database?.closeSync(); });

describe("cache-hit metrics with real DuckDB execution", () => {
  it("includes tokens written to cache in the total-input denominator", async () => {
    await query(`INSERT INTO main_analytics.fct_agent_traces VALUES
      (1, false, false, 0.01, 1000, 0, 100, 900, '[]', '2026-09-01'),
      (1, false, false, 0.01, 1000, 900, 100, 0, '[]', '2026-09-02')`);
    const metrics = await getMetrics();
    expect(metrics.turns).toBe(2);
    // 900 read / (900 written + 900 read + 200 uncached), not 900 / 1100.
    expect(metrics.cacheHitRate).toBeCloseTo(0.45, 8);
  });

  it("reports zero when input is only written to cache", async () => {
    await query(`INSERT INTO main_analytics.fct_agent_traces VALUES
      (1, false, false, 0.01, 1000, 0, 0, 900, '[]', '2026-09-01')`);
    expect((await getMetrics()).cacheHitRate).toBe(0);
  });

  it("returns finite zero metrics for an empty warehouse", async () => {
    const metrics = await getMetrics();
    expect(metrics.cacheHitRate).toBe(0);
    expect(metrics.turns).toBe(0);
  });
});
