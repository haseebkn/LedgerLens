import { createContext, useContext } from "react";

/**
 * The record behind a citation, as returned by GET /api/rows/:rowId
 * (agent/src/lib/rows.ts).
 */
export type RowLookup =
  | { kind: "source"; rowId: string; source: string; eventTimestamp: string | null; summaryText: string | null; payload: unknown }
  | { kind: "account_snapshot"; rowId: string; snapshot: Record<string, unknown> }
  | {
      kind: "computed";
      rowId: string;
      resultKind: "query" | "spend";
      sql: string;
      params?: unknown[];
      rows: Record<string, unknown>[];
      summary?: Record<string, unknown>;
    };

export type FetchRow = (rowId: string, signal: AbortSignal) => Promise<RowLookup>;

export const defaultFetchRow: FetchRow = async (rowId, signal) => {
  const response = await fetch(`/api/rows/${encodeURIComponent(rowId)}`, { signal });
  const body = (await response.json().catch(() => null)) as (RowLookup & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error ?? `Could not load ${rowId} (${response.status})`);
  return body;
};

export const OpenSourceContext = createContext<((rowId: string) => void) | null>(null);

/** Returns the drawer opener, or null outside a provider (chips then render as plain labels). */
export function useOpenSource() {
  return useContext(OpenSourceContext);
}
