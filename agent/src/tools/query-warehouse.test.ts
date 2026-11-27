import { describe, expect, it } from "vitest";
import { queryWarehouseTool } from "./query-warehouse.js";

// These run against the real financial_engine.db over a READ_ONLY connection
// — safe (no writes possible) and gives genuine confidence the guard and
// the DuckDB layer actually compose correctly, not just in isolation.

describe("query_warehouse tool (integration, real warehouse)", () => {
  it("runs an allowed aggregation query and returns rows", async () => {
    const result = await queryWarehouseTool.run({
      sql: "SELECT source, COUNT(*) AS n FROM main_analytics.fct_context_rows GROUP BY source ORDER BY source",
    });
    expect(result).toContain("calendar");
    expect(result).toContain("plaid");
    const parsed = JSON.parse(result as string);
    expect(parsed.result_id).toMatch(/^computed_query_[a-f0-9]{16}$/);
    expect(parsed.rows.length).toBeGreaterThan(0);
  });

  it("rejects a disallowed table with a clear reason fed back to the model", async () => {
    await expect(queryWarehouseTool.run({ sql: "SELECT * FROM main_analytics.nonexistent_table" }))
      .rejects.toThrow(/Query rejected:.*not in the allowed set/);
  });

  it("rejects a write statement", async () => {
    await expect(queryWarehouseTool.run({
      sql: "DELETE FROM main_analytics.fct_context_rows",
    })).rejects.toThrow(/Query rejected:.*Only SELECT queries/);
  });

  it("rejects a path-traversal attempt via a table function", async () => {
    await expect(queryWarehouseTool.run({
      sql: "SELECT * FROM read_text('../README.md')",
    })).rejects.toThrow(/Query rejected:.*disallowed function/);
  });

  it("returns citable computed provenance for a zero-row result", async () => {
    const result = await queryWarehouseTool.run({
      sql: "SELECT * FROM main_analytics.fct_context_rows WHERE row_id = 'this-row-id-does-not-exist'",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.result_id).toMatch(/^computed_query_[a-f0-9]{16}$/);
    expect(parsed.rows).toEqual([]);
    expect(parsed.note).toBe("Query returned 0 rows.");
  });

  it("surfaces a real DuckDB execution error usefully (bad column name)", async () => {
    await expect(queryWarehouseTool.run({
      sql: "SELECT this_column_does_not_exist FROM main_analytics.fct_context_rows",
    })).rejects.toThrow(/Query failed to execute/);
  });
});
