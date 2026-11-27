import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { SANDBOX_CONFIG } from "./duckdb.js";
import { guardSql } from "./sql-guard.js";

/**
 * Proves the engine — not the regex guard — refuses file reads. Each probe
 * goes straight to a connection opened with SANDBOX_CONFIG, bypassing
 * guardSql entirely, against a throwaway database and a throwaway "secret"
 * file. Before the sandbox, the split-string query() probe returned the
 * file's contents (reproduced against agent/.env).
 */
let dir: string;
let secretPath: string;
let instance: DuckDBInstance;
let conn: DuckDBConnection;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ledgerlens-sandbox-"));
  secretPath = join(dir, "secret.env").replaceAll("\\", "/");
  writeFileSync(secretPath, "ANTHROPIC_API_KEY=fixture-not-a-real-key\n");
  const dbPath = join(dir, "warehouse.db");
  const writer = await DuckDBInstance.create(dbPath);
  const w = await writer.connect();
  await w.run("CREATE SCHEMA main_analytics; CREATE TABLE main_analytics.fct_context_rows AS SELECT 'plaid_1' AS row_id, 'installment payment' AS summary_text;");
  w.closeSync();
  writer.closeSync();
  instance = await DuckDBInstance.create(dbPath, { ...SANDBOX_CONFIG });
  conn = await instance.connect();
});

afterAll(() => {
  conn?.closeSync();
  instance?.closeSync();
  rmSync(dir, { recursive: true, force: true });
});

describe("DuckDB engine sandbox", () => {
  it("runs ordinary warehouse queries", async () => {
    const rows = await conn.runAndReadAll("SELECT row_id FROM main_analytics.fct_context_rows WHERE summary_text ILIKE '%installment%'");
    expect(rows.getRowObjectsJson()).toEqual([{ row_id: "plaid_1" }]);
  });

  it("refuses the split-string query() file read even with the guard bypassed", async () => {
    const sql = `SELECT * FROM query('SELECT * FROM read_' || 'text(''${secretPath}'')')`;
    await expect(conn.runAndReadAll(sql)).rejects.toThrow(/Permission Error/);
  });

  it("refuses a direct file-reading table function", async () => {
    await expect(conn.runAndReadAll(`SELECT * FROM read_text('${secretPath}')`)).rejects.toThrow(/Permission Error/);
  });

  it("refuses to re-enable external access at runtime", async () => {
    await expect(conn.run("SET enable_external_access = true")).rejects.toThrow(/locked/);
  });

  it("refuses writes", async () => {
    await expect(conn.run("CREATE TABLE main_analytics.x AS SELECT 1")).rejects.toThrow();
  });

  it("guard and engine agree on an ILIKE search containing a banned keyword", async () => {
    const guarded = guardSql("SELECT row_id FROM main_analytics.fct_context_rows WHERE summary_text ILIKE '%installment%'");
    expect(guarded.ok).toBe(true);
    const rows = await conn.runAndReadAll(guarded.sql!);
    expect(rows.getRowObjectsJson()).toHaveLength(1);
  });
});
