import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryRowsParams } from "./duckdb.js";
import { rankContextRows, searchLocalContext, stem, tokenize, type ContextRow } from "./local-retrieval.js";

vi.mock("./duckdb.js", () => ({ queryRowsParams: vi.fn() }));

const SAMPLE_ROWS: ContextRow[] = [
  {
    row_id: "plaid_coffee_old",
    source: "plaid",
    record_date: "2026-06-05 00:00:00",
    summary_text: "Financial Transaction: Spent $4.33 at Starbucks under category Food and Drink on 2026-06-05.",
    raw_payload: JSON.stringify({ name: "Starbucks", category: "Food and Drink", amount: 4.33 }),
  },
  {
    row_id: "plaid_coffee_new",
    source: "plaid",
    record_date: "2026-11-20 00:00:00",
    summary_text: "Financial Transaction: Spent $4.33 at Starbucks under category Food and Drink on 2026-11-20.",
    raw_payload: JSON.stringify({ name: "Starbucks", category: "Food and Drink", amount: 4.33 }),
  },
  {
    row_id: "plaid_hardware",
    source: "plaid",
    record_date: "2026-09-10 00:00:00",
    summary_text: "Financial Transaction: Spent $62.10 at Canadian Tire under category Shops on 2026-09-10.",
    raw_payload: JSON.stringify({ name: "Canadian Tire", category: ["Shops", "Hardware Store"], amount: 62.10 }),
  },
  {
    row_id: "calendar_climb",
    source: "calendar",
    record_date: "2026-11-24 22:00:00",
    summary_text: "Calendar Event: Rock climbing at Wallnut Climbing Gym. Description: Bouldering session",
    raw_payload: JSON.stringify({ summary: "Rock climbing", location: "Wallnut Climbing Gym", description: "Bouldering session" }),
  },
  {
    row_id: "calendar_dentist",
    source: "calendar",
    record_date: "2026-08-30 16:30:00",
    summary_text: "Calendar Event: Dentist appointment at Water Street Dental. Description: Cleaning and checkup",
    raw_payload: JSON.stringify({ summary: "Dentist appointment", location: "Water Street Dental" }),
  },
  {
    row_id: "alpaca_aapl",
    source: "alpaca",
    record_date: "2026-07-15 14:30:00",
    summary_text: "Financial Trade: BUY order of 5 shares of AAPL (market) was filled at average price $229.15 on 2026-07-15 14:30.",
    raw_payload: JSON.stringify({ symbol: "AAPL", side: "buy", quantity: 5 }),
  },
];

describe("local retrieval ranking", () => {
  it("stems common English suffixes cleanly", () => {
    expect(stem("climbing")).toBe("climb");
    expect(stem("groceries")).toBe("grocery");
    expect(stem("purchases")).toBe("purchase");
    expect(stem("trades")).toBe("trade");
  });

  it("drops grammatical stop words while keeping financial terms", () => {
    expect(tokenize("Did I buy any coffee recently?")).toEqual(["buy", "coffee"]);
    expect(tokenize("the")).toEqual(["the"]); // fallback when all tokens are stop words
  });

  it("matches semantic queries via domain synonyms and structured payload fields", () => {
    const coffee = rankContextRows(SAMPLE_ROWS, "coffee", 5);
    expect(coffee.map((r) => r.row_id)).toEqual(["plaid_coffee_new", "plaid_coffee_old"]);
    expect(coffee[0]!.similarity).toBeGreaterThan(0);
    expect(coffee[0]!.similarity).toBeLessThan(1);

    const hardware = rankContextRows(SAMPLE_ROWS, "hardware store", 5);
    expect(hardware[0]?.row_id).toBe("plaid_hardware");

    const climbing = rankContextRows(SAMPLE_ROWS, "Did I go rock climbing recently?", 5);
    expect(climbing[0]?.row_id).toBe("calendar_climb");

    const dentist = rankContextRows(SAMPLE_ROWS, "my dentist appointment", 5);
    expect(dentist[0]?.row_id).toBe("calendar_dentist");

    const stock = rankContextRows(SAMPLE_ROWS, "AAPL stock trade", 5);
    expect(stock[0]?.row_id).toBe("alpaca_aapl");
  });

  it("breaks equal-score ties by recency (newest record first)", () => {
    const results = rankContextRows(SAMPLE_ROWS, "Starbucks", 2);
    expect(results.map((r) => r.row_id)).toEqual(["plaid_coffee_new", "plaid_coffee_old"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(rankContextRows(SAMPLE_ROWS, "xylophone submarine", 5)).toEqual([]);
  });
});

describe("searchLocalContext SQL filtering", () => {
  beforeEach(() => {
    vi.mocked(queryRowsParams).mockReset().mockResolvedValue(SAMPLE_ROWS as unknown as Record<string, unknown>[]);
  });

  it("passes parameterized source and inclusive date-only bounds to DuckDB", async () => {
    const results = await searchLocalContext({
      query: "dentist",
      limit: 3,
      source: "calendar",
      after: "2026-08-01",
      before: "2026-08-31",
    });

    expect(results[0]?.row_id).toBe("calendar_dentist");
    const [sql, values] = vi.mocked(queryRowsParams).mock.calls[0]!;
    expect(sql).toContain("source = $1");
    expect(sql).toContain("event_timestamp >= CAST($2 AS TIMESTAMP)");
    expect(sql).toContain("event_timestamp < CAST($3 AS TIMESTAMP) + INTERVAL 1 DAY");
    expect(values).toEqual(["calendar", "2026-08-01", "2026-08-31"]);
  });

  it("rejects inverted or timezone-bearing date bounds", async () => {
    await expect(
      searchLocalContext({ query: "coffee", limit: 5, after: "2026-09-01", before: "2026-08-01" }),
    ).rejects.toThrow(/after must not be later than before/);

    await expect(
      searchLocalContext({ query: "coffee", limit: 5, after: "2026-08-01T00:00:00Z" }),
    ).rejects.toThrow(/without a timezone/);
  });
});
