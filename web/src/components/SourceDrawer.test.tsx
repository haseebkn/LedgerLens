import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SourceDrawerProvider } from "./SourceDrawer.js";
import type { FetchRow } from "../lib/source-rows.js";
import { MessageText } from "./MessageText.js";

afterEach(cleanup);

function renderAnswer(text: string, fetchRow: FetchRow) {
  return render(
    <SourceDrawerProvider fetchRow={fetchRow}>
      <MessageText text={text} />
    </SourceDrawerProvider>,
  );
}

describe("citation source drawer", () => {
  it("opens a cited source row with its key fields and raw record", async () => {
    const fetchRow = vi.fn<FetchRow>(async () => ({
      kind: "source", rowId: "plaid_tx1", source: "plaid", eventTimestamp: "2026-03-02 00:00:00",
      summaryText: "Coffee at Bean Co",
      payload: { merchant_name: "Bean Co", amount: 4.5, category: "Food and Drink" },
    }));
    renderAnswer("Coffee was $4.50 [plaid_tx1].", fetchRow);

    fireEvent.click(screen.getByRole("button", { name: /Open Plaid source plaid_tx1/ }));
    const drawer = screen.getByRole("dialog", { name: "Plaid transaction" });
    expect(await screen.findByText("Bean Co")).toBeInTheDocument();
    expect(drawer).toHaveTextContent("4.5");
    expect(drawer).toHaveTextContent("Food and Drink");
    expect(fetchRow).toHaveBeenCalledWith("plaid_tx1", expect.any(AbortSignal));
  });

  it("shows a computed result's SQL and rows", async () => {
    const fetchRow: FetchRow = async () => ({
      kind: "computed", rowId: "computed_query_abc", resultKind: "query",
      sql: "SELECT SUM(amount) AS total FROM main_analytics.fct_context_rows", rows: [{ total: 12 }],
    });
    renderAnswer("Total is $12 [computed_query_abc].", fetchRow);
    fireEvent.click(screen.getByRole("button", { name: /computed_query_abc/ }));
    expect(await screen.findByText(/SELECT SUM\(amount\)/)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "total" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "12" })).toBeInTheDocument();
  });

  it("switches to another citation while the drawer is open", async () => {
    const fetchRow: FetchRow = async (rowId) => ({
      kind: "source", rowId, source: "plaid", eventTimestamp: null, summaryText: `Summary for ${rowId}`, payload: {},
    });
    renderAnswer("Coffee [plaid_a] and lunch [plaid_b].", fetchRow);
    fireEvent.click(screen.getByRole("button", { name: /plaid_a/ }));
    expect(await screen.findByText("Summary for plaid_a")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /plaid_b/ }));
    expect(await screen.findByText("Summary for plaid_b")).toBeInTheDocument();
    expect(screen.queryByText("Summary for plaid_a")).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("explains a lookup failure and closes on Escape", async () => {
    const fetchRow: FetchRow = async () => { throw new Error("This computed result is no longer available."); };
    renderAnswer("Total is $12 [computed_query_gone].", fetchRow);
    fireEvent.click(screen.getByRole("button", { name: /computed_query_gone/ }));
    expect(await screen.findByText(/no longer available/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
