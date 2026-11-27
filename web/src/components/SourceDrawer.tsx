import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { sourceFromRowId } from "../lib/message-parts.js";

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

const OpenSourceContext = createContext<((rowId: string) => void) | null>(null);

/** Returns the drawer opener, or null outside a provider (chips then render as plain labels). */
export function useOpenSource() {
  return useContext(OpenSourceContext);
}

export function SourceDrawerProvider({ children, fetchRow = defaultFetchRow }: { children: ReactNode; fetchRow?: FetchRow }) {
  const [rowId, setRowId] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const open = useCallback((id: string) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRowId(id);
  }, []);
  const close = useCallback(() => {
    setRowId(null);
    returnFocus.current?.focus();
  }, []);

  return (
    <OpenSourceContext.Provider value={open}>
      {children}
      {rowId && <SourceDrawer rowId={rowId} fetchRow={fetchRow} onClose={close} />}
    </OpenSourceContext.Provider>
  );
}

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; row: RowLookup };

function SourceDrawer({ rowId, fetchRow, onClose }: { rowId: string; fetchRow: FetchRow; onClose: () => void }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchRow(rowId, controller.signal)
      .then((row) => setState({ status: "ready", row }))
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => controller.abort();
  }, [rowId, fetchRow]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const titleId = `source-drawer-title-${rowId}`;
  return (
    <aside className="source-drawer" role="dialog" aria-modal="false" aria-labelledby={titleId}>
      <header className="source-drawer-header">
        <div>
          <h2 id={titleId} className="source-drawer-title">{drawerTitle(rowId)}</h2>
          <code className="source-drawer-id">{rowId}</code>
        </div>
        <button ref={closeRef} type="button" className="link-button" onClick={onClose} aria-label="Close source">
          Close
        </button>
      </header>
      <div className="source-drawer-body">
        {state.status === "loading" && <p className="muted">Loading source…</p>}
        {state.status === "error" && <p className="message-text--error">{state.message}</p>}
        {state.status === "ready" && <RowDetails row={state.row} />}
      </div>
    </aside>
  );
}

function drawerTitle(rowId: string): string {
  const source = sourceFromRowId(rowId);
  if (rowId.startsWith("alpaca_account_")) return "Alpaca account snapshot";
  if (source === "Computed") return "Computed result";
  if (source === "Plaid") return "Plaid transaction";
  if (source === "Calendar") return "Calendar event";
  if (source === "Alpaca") return "Alpaca order";
  return "Source record";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The fields a reader checks first, pulled from the source payload when present. */
function keyFields(row: Extract<RowLookup, { kind: "source" }>): [string, unknown][] {
  const p = asRecord(row.payload);
  const pick = (...keys: string[]) => keys.map((k) => p[k]).find((v) => v !== undefined && v !== null && v !== "");
  const fields: [string, unknown][] = [
    ["Merchant", pick("merchant_name", "name", "merchant")],
    ["Amount", pick("amount")],
    ["Date", pick("date", "authorized_date", "start_time_utc", "source_start") ?? row.eventTimestamp],
    ["Category", pick("category", "personal_finance_category")],
    ["Title", pick("summary", "symbol")],
    ["Side", pick("side")],
    ["Quantity", pick("quantity")],
  ];
  return fields.filter(([, v]) => v !== undefined && v !== null && v !== "");
}

function RowDetails({ row }: { row: RowLookup }) {
  if (row.kind === "computed") {
    return (
      <>
        <h3 className="source-drawer-subtitle">SQL</h3>
        <pre className="source-drawer-pre">{row.sql}</pre>
        {row.params && row.params.length > 0 && (
          <p className="muted">Parameters: {row.params.map(display).join(", ")}</p>
        )}
        {row.summary && <FieldList fields={Object.entries(row.summary)} />}
        <h3 className="source-drawer-subtitle">Result ({row.rows.length} rows)</h3>
        <ResultTable rows={row.rows} />
      </>
    );
  }
  if (row.kind === "account_snapshot") {
    return <FieldList fields={Object.entries(row.snapshot)} />;
  }
  return (
    <>
      <FieldList fields={keyFields(row)} />
      {row.summaryText && <p className="source-drawer-summary">{row.summaryText}</p>}
      <details className="source-drawer-raw">
        <summary>Raw record</summary>
        <pre className="source-drawer-pre">{JSON.stringify(row.payload, null, 2)}</pre>
      </details>
    </>
  );
}

function FieldList({ fields }: { fields: [string, unknown][] }) {
  if (fields.length === 0) return null;
  return (
    <dl className="source-drawer-fields">
      {fields.map(([k, v]) => (
        <div key={k} className="source-drawer-field">
          <dt>{k}</dt>
          <dd>{display(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

const MAX_TABLE_ROWS = 50;

function ResultTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return <p className="muted">No rows.</p>;
  const columns = [...new Set(rows.slice(0, MAX_TABLE_ROWS).flatMap((r) => Object.keys(r)))];
  return (
    <div className="message-table-scroll">
      <table className="message-table">
        <thead>
          <tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, MAX_TABLE_ROWS).map((r, i) => (
            <tr key={i}>{columns.map((c) => <td key={c}>{display(r[c])}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_TABLE_ROWS && <p className="muted">Showing the first {MAX_TABLE_ROWS} rows.</p>}
    </div>
  );
}
