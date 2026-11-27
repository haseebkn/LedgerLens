import { queryRowsParams } from "./duckdb.js";
import { getComputedResult } from "./result-store.js";

/**
 * Resolves a cited id to the record behind it, for the UI's source drawer.
 * Every lookup is parameterized; nothing from the id is interpolated into
 * SQL.
 */

export const ROW_ID_FORMAT = /^(?:calendar|plaid|alpaca|computed)_[a-zA-Z0-9_-]{1,200}$/;

export type RowLookup =
  | {
      kind: "source";
      rowId: string;
      source: string;
      eventTimestamp: string | null;
      summaryText: string | null;
      payload: unknown;
    }
  | {
      kind: "account_snapshot";
      rowId: string;
      snapshot: Record<string, unknown>;
    }
  | {
      kind: "computed";
      rowId: string;
      resultKind: "query" | "spend";
      sql: string;
      params?: (string | number | boolean | null)[];
      rows: Record<string, unknown>[];
      summary?: Record<string, unknown>;
    };

function parsePayload(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Same derivation as get_portfolio_snapshot's synthesized row id. */
export function snapshotStamp(extractedAt: unknown): string {
  return String(extractedAt ?? "").replace(/[^0-9]/g, "");
}

export async function getRowById(rowId: string): Promise<RowLookup | null> {
  if (!ROW_ID_FORMAT.test(rowId)) return null;

  if (rowId.startsWith("computed_")) {
    const entry = getComputedResult(rowId);
    if (!entry) return null;
    return {
      kind: "computed",
      rowId,
      resultKind: entry.kind,
      sql: entry.sql,
      params: entry.params,
      rows: entry.rows,
      summary: entry.summary,
    };
  }

  if (rowId.startsWith("alpaca_account_")) {
    const rest = rowId.slice("alpaca_account_".length);
    const cut = rest.lastIndexOf("_");
    if (cut <= 0) return null;
    const accountId = rest.slice(0, cut);
    const stamp = rest.slice(cut + 1);
    const snapshots = await queryRowsParams(
      `SELECT account_id, status, cash, equity, portfolio_value, buying_power,
              long_market_value, short_market_value, extracted_at
       FROM main_analytics.dim_account_snapshot
       WHERE account_id = $1
       ORDER BY extracted_at DESC
       LIMIT 500`,
      [accountId],
    );
    const snapshot = snapshots.find((row) => snapshotStamp(row["extracted_at"]) === stamp);
    return snapshot ? { kind: "account_snapshot", rowId, snapshot } : null;
  }

  const rows = await queryRowsParams(
    `SELECT row_id, source, CAST(event_timestamp AS VARCHAR) AS event_timestamp, summary_text, raw_payload
     FROM main_analytics.fct_context_rows
     WHERE row_id = $1
     LIMIT 1`,
    [rowId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    kind: "source",
    rowId,
    source: String(row["source"] ?? "unknown"),
    eventTimestamp: row["event_timestamp"] == null ? null : String(row["event_timestamp"]),
    summaryText: row["summary_text"] == null ? null : String(row["summary_text"]),
    payload: parsePayload(row["raw_payload"]),
  };
}
