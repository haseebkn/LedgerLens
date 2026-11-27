import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { guardSql } from "./sql-guard.js";

let database: DuckDBInstance;
let connection: DuckDBConnection;

beforeAll(async () => {
  database = await DuckDBInstance.create(":memory:");
  connection = await database.connect();
  await connection.run(`
    CREATE SCHEMA main_analytics;
    CREATE TABLE main_analytics.fct_context_rows AS SELECT range AS id FROM range(600);
    CREATE TABLE secret_table AS SELECT 'fixture-only secret' AS private_value;
  `);
});
afterAll(() => {
  connection?.closeSync();
  database?.closeSync();
});

describe("SQL guard against an isolated in-memory DuckDB", () => {
  it.each([
    "SELECT * FROM main_analytics.fct_context_rows OFFSET 1",
    "SELECT * FROM main_analytics.fct_context_rows -- trailing note",
  ])("enforces the injected cap in DuckDB: %s", async (sql) => {
    const guarded = guardSql(sql);
    expect(guarded.ok).toBe(true);
    const rows = await connection.runAndReadAll(guarded.sql!);
    expect(rows.getRowObjectsJson()).toHaveLength(500);
  });

  it("executes a bounded UNION without a duplicate LIMIT syntax error", async () => {
    const guarded = guardSql("SELECT * FROM main_analytics.fct_context_rows UNION ALL SELECT * FROM main_analytics.fct_context_rows LIMIT 10");
    const rows = await connection.runAndReadAll(guarded.sql!);
    expect(rows.getRowObjectsJson()).toHaveLength(10);
  });

  it.each([
    "WITH secret_table AS (SELECT secret_table.private_value FROM secret_table CROSS JOIN main_analytics.fct_context_rows) SELECT * FROM secret_table LIMIT 1",
    "WITH first_cte AS (SELECT secret_table.private_value FROM secret_table CROSS JOIN main_analytics.fct_context_rows), secret_table AS (SELECT id FROM main_analytics.fct_context_rows) SELECT * FROM first_cte LIMIT 1",
    "SELECT secret_table.private_value FROM main_analytics.fct_context_rows CROSS JOIN query_table('secret_table') secret_table LIMIT 1",
  ])("rejects a query that DuckDB could use to read a non-warehouse table: %s", async (sql) => {
    // Proves the binder behavior with synthetic data only, never a real file.
    const unchecked = await connection.runAndReadAll(sql);
    expect(unchecked.getRowObjectsJson()).toEqual([{ private_value: "fixture-only secret" }]);
    expect(guardSql(sql).ok).toBe(false);
  });
});
