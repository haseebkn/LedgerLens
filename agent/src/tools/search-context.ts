import { z } from "zod/v4";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { env } from "../config.js";
import { queryRowsParams } from "../lib/duckdb.js";
import { calendarContext } from "../lib/calendar-time.js";

const SearchContextSchema = z
  .object({
    query: z.string().min(1).describe("Natural-language description of what to find, e.g. 'Uber rides in June' or 'dentist appointment'."),
    limit: z.number().int().min(1).max(20).default(5).describe("Maximum number of results to return."),
    source: z
      .enum(["calendar", "plaid", "alpaca"])
      .optional()
      .describe("Restrict results to one source system. Omit to search across all sources."),
    after: z
      .string()
      .optional()
      .describe("Only return records on or after this date (YYYY-MM-DD)."),
    before: z
      .string()
      .optional()
      .describe("Only return records on or before this date (YYYY-MM-DD)."),
  })
  .strict();

interface RetrievalResult {
  row_id: string;
  document: string;
  source: string;
  record_date: string;
  distance: number;
  similarity: number;
}

export const searchContextTool = betaZodTool({
  name: "search_context",
  description:
    "Semantic search over the user's financial and calendar context: calendar events, Plaid bank " +
    "transactions, and Alpaca trade orders. Call this when the question is about a specific event, " +
    "merchant, or transaction that natural-language similarity can find — 'what did I buy at the " +
    "hardware store', 'my dentist appointment'. For totals, sums, or counts across many records, use " +
    "query_warehouse or summarize_spend instead — semantic search ranks by similarity, not by " +
    "correctness of aggregation, and will silently miss rows that don't rank in the top results.",
  inputSchema: SearchContextSchema,
  run: async (args) => {
    const url = new URL("/api/search", env.RETRIEVAL_SERVICE_URL);
    url.searchParams.set("q", args.query);
    url.searchParams.set("limit", String(args.limit));
    if (args.source) url.searchParams.set("source", args.source);
    if (args.after) url.searchParams.set("after", args.after);
    if (args.before) url.searchParams.set("before", args.before);

    const response = await fetch(url, {
      headers: { "X-Internal-Token": env.RETRIEVAL_SERVICE_TOKEN },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`search_context failed: retrieval service returned ${response.status}. ${body}`.trim());
    }

    const data = (await response.json()) as { query: string; results: RetrievalResult[] };
    if (data.results.length === 0) {
      return `No results found for "${args.query}". The warehouse may not have data matching this query — say so rather than guessing.`;
    }

    // Hydrate times from the current warehouse, not possibly stale vector text.
    // Formatting in code avoids asking the model to calculate DST/half-hour offsets.
    const calendarIds = data.results.filter(r => r.source === "calendar").map(r => r.row_id);
    const calendarRows = calendarIds.length === 0 ? [] : await queryRowsParams(
      `SELECT row_id, raw_payload FROM main_analytics.fct_context_rows WHERE source = 'calendar' AND row_id IN (${calendarIds.map((_, i) => `$${i + 1}`).join(", ")})`,
      calendarIds,
    );
    const calendarPayloads = new Map(calendarRows.map(row => [String(row.row_id),
      typeof row.raw_payload === "string" ? JSON.parse(row.raw_payload) as Record<string, unknown> : row.raw_payload as Record<string, unknown>,
    ]));

    return JSON.stringify(
      data.results.map((r) => {
        const calendar = r.source === "calendar"
          ? calendarContext(calendarPayloads.get(r.row_id) ?? {}, env.USER_TIME_ZONE)
          : undefined;
        const date = calendar
          ? calendar.calendar_time.kind === "timed" ? calendar.calendar_time.start_local
            : calendar.calendar_time.kind === "all_day" ? calendar.calendar_time.start_date : undefined
          : r.record_date;
        return {
          row_id: r.row_id,
          text: r.document,
          source: r.source,
          date,
          similarity: Math.round(r.similarity * 1000) / 1000,
          ...calendar,
        };
      }),
      null,
      2
    );
  },
});
