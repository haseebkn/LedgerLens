import { describe, expect, it } from "vitest";
import { guardSql } from "./sql-guard.js";

describe("guardSql", () => {
  it("allows a plain select against an allowed table", () => {
    const result = guardSql("SELECT * FROM main_analytics.fct_context_rows");
    expect(result.ok).toBe(true);
    expect(result.sql).toContain("LIMIT 500"); // injected default
  });

  it("preserves an explicit LIMIT under the max", () => {
    const result = guardSql("SELECT * FROM main_analytics.fct_context_rows LIMIT 10");
    expect(result.ok).toBe(true);
    expect(result.sql).toBe("SELECT * FROM main_analytics.fct_context_rows LIMIT 10");
  });

  it("rejects a LIMIT above the maximum", () => {
    const result = guardSql("SELECT * FROM main_analytics.fct_context_rows LIMIT 5000");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds the maximum/);
  });

  it("tolerates a single trailing semicolon", () => {
    const result = guardSql("SELECT * FROM main_analytics.fct_context_rows;");
    expect(result.ok).toBe(true);
  });

  it("rejects statement chaining via semicolons", () => {
    const result = guardSql(
      "SELECT * FROM main_analytics.fct_context_rows; DROP TABLE main_analytics.fct_context_rows;"
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/single SQL statement/);
  });

  it("rejects DELETE", () => {
    const result = guardSql("DELETE FROM main_analytics.fct_context_rows");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Only SELECT queries/);
  });

  it("rejects DROP", () => {
    const result = guardSql("DROP TABLE main_analytics.fct_context_rows");
    expect(result.ok).toBe(false);
  });

  it("rejects a table not in the allowlist", () => {
    const result = guardSql("SELECT * FROM main_analytics.some_other_table");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not in the allowed set/);
  });

  it("rejects a query with no real table reference", () => {
    const result = guardSql("SELECT 1 + 1 AS x");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not reference any warehouse table/);
  });

  it("allows a CTE built on an allowed table", () => {
    const result = guardSql(
      "WITH recent AS (SELECT * FROM main_analytics.fct_context_rows) SELECT * FROM recent"
    );
    expect(result.ok).toBe(true);
  });

  it("rejects read_csv_auto even though it never surfaces as a table reference", () => {
    // Regression case: node-sql-parser's tableList() returns [] for this
    // query, so a naive "empty table list -> nothing to check" guard would
    // let it through. The banned-function regex is what actually catches it.
    const result = guardSql("SELECT * FROM read_csv_auto('/etc/passwd')");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/disallowed function/);
  });

  it("rejects read_json_auto", () => {
    const result = guardSql("SELECT * FROM read_json_auto('/etc/passwd')");
    expect(result.ok).toBe(false);
  });

  it("rejects ATTACH", () => {
    const result = guardSql("ATTACH 'evil.db' AS evil");
    expect(result.ok).toBe(false);
  });

  it("rejects INSTALL/LOAD extension statements", () => {
    expect(guardSql("INSTALL httpfs").ok).toBe(false);
    expect(guardSql("LOAD httpfs").ok).toBe(false);
  });

  it("rejects PRAGMA", () => {
    const result = guardSql("PRAGMA database_list");
    expect(result.ok).toBe(false);
  });

  it("rejects COPY", () => {
    const result = guardSql("COPY main_analytics.fct_context_rows TO 'out.csv'");
    expect(result.ok).toBe(false);
  });

  it("rejects unparseable SQL with a clear reason", () => {
    const result = guardSql("SELEKT * FROM main_analytics.fct_context_rows");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/failed to parse/);
  });

  it("allows a join across two allowed tables", () => {
    const result = guardSql(
      "SELECT a.row_id FROM main_analytics.fct_context_rows a " +
        "JOIN main_staging.stg_alpaca_orders b ON a.row_id = b.order_id"
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a join where one side is disallowed", () => {
    const result = guardSql(
      "SELECT a.row_id FROM main_analytics.fct_context_rows a " +
        "JOIN main_analytics.some_secret_table b ON a.row_id = b.id"
    );
    expect(result.ok).toBe(false);
  });

  /**
   * Regression: LIMIT used to be appended with a space, so a query ending in
   * a line comment swallowed it — "SELECT ... -- note LIMIT 500" parses as a
   * comment and DuckDB runs the query uncapped. Verified against the real
   * warehouse before the fix: a self-join that should have been capped at
   * 500 returned 8836 rows.
   */
  it("keeps the injected LIMIT outside a trailing line comment", () => {
    const result = guardSql("SELECT * FROM main_analytics.fct_context_rows -- note");
    expect(result.ok).toBe(true);
    expect(result.sql!.split("\n").pop()).toBe("LIMIT 500");
  });

  it("keeps the injected LIMIT outside a comment on its own trailing line", () => {
    const result = guardSql("SELECT * FROM main_analytics.fct_context_rows\n-- trailing");
    expect(result.ok).toBe(true);
    expect(result.sql!.split("\n").pop()).toBe("LIMIT 500");
  });

  it("still appends a LIMIT to an ordinary unlimited query", () => {
    const result = guardSql("SELECT * FROM main_analytics.fct_context_rows");
    expect(result.ok).toBe(true);
    expect(result.sql!.split("\n").pop()).toBe("LIMIT 500");
  });

  it.each([
    "SELECT * FROM main_analytics.fct_context_rows, secret_table",
    "SELECT * FROM main_analytics.fct_context_rows WHERE EXISTS (SELECT 1 FROM secret_table)",
    "SELECT * FROM main_analytics.fct_context_rows UNION ALL SELECT * FROM secret_table",
    "SELECT * FROM main_analytics.fct_context_rows, query_table('secret_table')",
    "SELECT * FROM main_analytics.fct_context_rows, query('SELECT * FROM secret_table')",
    "SELECT * FROM main_analytics.fct_context_rows, duckdb_settings()",
    "WITH x AS (SELECT * FROM main_analytics.fct_context_rows) SELECT * FROM x, secret_table",
    "SELECT * FROM secret_table WHERE EXISTS (WITH secret_table AS (SELECT * FROM main_analytics.fct_context_rows) SELECT * FROM secret_table)",
    "WITH secret_table AS (SELECT * FROM secret_table CROSS JOIN main_analytics.fct_context_rows) SELECT * FROM secret_table",
    "WITH first_cte AS (SELECT * FROM secret_table CROSS JOIN main_analytics.fct_context_rows), secret_table AS (SELECT * FROM main_analytics.fct_context_rows) SELECT * FROM first_cte",
  ])("rejects hidden table access: %s", (sql) => {
    expect(guardSql(sql).ok).toBe(false);
  });

  it.each(["ALL", "-1", "5000 OFFSET 1", "10 OFFSET 5000", "1.5"])(
    "rejects an unbounded or invalid LIMIT/OFFSET: %s", (limit) => {
      expect(guardSql(`SELECT * FROM main_analytics.fct_context_rows LIMIT ${limit}`).ok).toBe(false);
    }
  );

  it("caps an OFFSET-only query instead of mistaking OFFSET for LIMIT", () => {
    const result = guardSql("SELECT * FROM main_analytics.fct_context_rows OFFSET 1");
    expect(result.ok).toBe(true);
    expect(result.sql).toContain("LIMIT 500");
  });

  it("preserves a bounded UNION without appending a duplicate LIMIT", () => {
    const sql = "SELECT * FROM main_analytics.fct_context_rows UNION ALL SELECT * FROM main_analytics.fct_context_rows LIMIT 10";
    expect(guardSql(sql)).toEqual({ ok: true, sql });
  });

  it("allows a CTE definition to query an earlier sibling", () => {
    expect(guardSql("WITH first_cte AS (SELECT * FROM main_analytics.fct_context_rows), second_cte AS (SELECT * FROM first_cte) SELECT * FROM second_cte").ok).toBe(true);
  });

  it("rejects recursive definitions whose physical-table binding cannot be established", () => {
    expect(guardSql("WITH RECURSIVE x AS (SELECT * FROM main_analytics.fct_context_rows UNION ALL SELECT * FROM x) SELECT * FROM x").ok).toBe(false);
  });
});
