import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchContextTool } from "./search-context.js";
import { queryRowsParams } from "../lib/duckdb.js";

vi.mock("../lib/duckdb.js", () => ({ queryRowsParams: vi.fn() }));

describe("search_context tool", () => {
  beforeEach(() => {
    vi.mocked(queryRowsParams).mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the request URL with query params and the auth header", async () => {
    const fetchMock = vi.fn(async (url: URL, _init?: RequestInit) => {
      expect(url.pathname).toBe("/api/search");
      expect(url.searchParams.get("q")).toBe("coffee shop");
      expect(url.searchParams.get("limit")).toBe("5");
      expect(url.searchParams.get("source")).toBe("plaid");
      return new Response(JSON.stringify({ query: "coffee shop", results: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await searchContextTool.run({ query: "coffee shop", limit: 5, source: "plaid" });

    const [urlArg, initArg] = fetchMock.mock.calls[0]!;
    expect((initArg as RequestInit).headers).toMatchObject({ "X-Internal-Token": "test-internal-token" });
    expect((initArg as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("returns formatted results with rounded similarity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            query: "coffee",
            results: [
              {
                row_id: "plaid_t1",
                document: "Financial Transaction: Spent $4.50 at Corner Coffee",
                source: "plaid",
                record_date: "2026-01-02 09:00:00",
                distance: 0.123456,
                similarity: 0.876544,
              },
            ],
          }),
          { status: 200 }
        )
      )
    );

    const result = (await searchContextTool.run({ query: "coffee", limit: 5 })) as string;
    const parsed = JSON.parse(result);
    expect(parsed[0].row_id).toBe("plaid_t1");
    expect(parsed[0].similarity).toBe(0.877); // rounded to 3dp
  });

  it("returns a clear no-results message rather than an empty array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ query: "xyz", results: [] }), { status: 200 }))
    );

    const result = (await searchContextTool.run({ query: "xyz", limit: 5 })) as string;
    expect(result).toMatch(/No results found for "xyz"/);
  });

  it("replaces stale unlabelled vector times with authoritative user-local calendar times", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [{
      row_id: "calendar_fixture-event-1", document: "Dentist from 2026-01-05 19:00 to 20:00",
      source: "calendar", record_date: "2026-01-05 19:00:00", similarity: 0.9,
    }] }))));
    vi.mocked(queryRowsParams).mockResolvedValue([{ row_id: "calendar_fixture-event-1", raw_payload: JSON.stringify({ summary: "Dentist Appointment", all_day: false, start_time_utc: "2026-01-05T19:00:00Z", end_time_utc: "2026-01-05T20:00:00Z" }) }]);
    const [row] = JSON.parse(await searchContextTool.run({ query: "dentist", limit: 5 }) as string);
    expect(row.row_id).toBe("calendar_fixture-event-1");
    expect(row.text).toContain("15:30 (UTC-03:30, America/St_Johns)");
    expect(row.text).not.toContain("from 2026-01-05 19:00");
    expect(row.date).toBe("2026-01-05 15:30 (UTC-03:30, America/St_Johns)");
    expect(row.calendar_time.kind).toBe("timed");
    expect(vi.mocked(queryRowsParams).mock.calls[0]?.[1]).toEqual(["calendar_fixture-event-1"]);
  });

  it("does not fall back to misleading vector times if the mart lacks timezone metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [{ row_id: "calendar_legacy", document: "Dentist at 19:00", source: "calendar", record_date: "2026-01-05 19:00:00", similarity: 0.9 }] }))));
    const [row] = JSON.parse(await searchContextTool.run({ query: "dentist", limit: 5 }) as string);
    expect(row.calendar_time.kind).toBe("unknown");
    expect(row.text).not.toContain("19:00");
    expect(row.date).toBeUndefined();
  });

  it("surfaces a non-200 response from the retrieval service usefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 }))
    );

    await expect(searchContextTool.run({ query: "coffee", limit: 5 }))
      .rejects.toThrow(/search_context failed:.*401/);
  });

  it("uses in-process DuckDB retrieval without HTTP when RETRIEVAL_MODE=local", async () => {
    const { env } = await import("../config.js");
    const prev = env.RETRIEVAL_MODE;
    (env as { RETRIEVAL_MODE: "http" | "local" }).RETRIEVAL_MODE = "local";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(queryRowsParams).mockResolvedValue([
      {
        row_id: "plaid_coffee_1",
        summary_text: "Financial Transaction: Spent $4.33 at Starbucks under category Food and Drink on 2026-11-20.",
        source: "plaid",
        record_date: "2026-11-20 00:00:00",
        raw_payload: JSON.stringify({ name: "Starbucks", category: "Food and Drink" }),
      },
    ]);

    try {
      const result = JSON.parse((await searchContextTool.run({ query: "coffee", limit: 5 })) as string);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result[0].row_id).toBe("plaid_coffee_1");
      expect(result[0].source).toBe("plaid");
    } finally {
      (env as { RETRIEVAL_MODE: "http" | "local" }).RETRIEVAL_MODE = prev;
    }
  });
});
