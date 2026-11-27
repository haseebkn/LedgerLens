import { describe, expect, it } from "vitest";
import { buildTraceRecord } from "./trace-accumulator.js";
import type { AgentStreamEvent } from "../streaming-types.js";

const DONE = (overrides: Partial<Extract<AgentStreamEvent, { type: "done" }>> = {}): AgentStreamEvent => ({
  type: "done",
  traceId: "t1",
  stopReason: "end_turn",
  usage: { inputTokens: 500, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 400, estimatedCostUsd: 0.005 },
  totalDurationMs: 1200,
  iterations: 2,
  repaired: false,
  ...overrides,
});

describe("buildTraceRecord", () => {
  it("builds a clean record from a well-behaved turn", () => {
    const events: AgentStreamEvent[] = [
      { type: "tool_call", traceId: "t1", toolCallId: "tc1", name: "search_context", input: {} },
      { type: "tool_result", traceId: "t1", toolCallId: "tc1", name: "search_context", isError: false, summary: "ok", durationMs: 200 },
      { type: "text_delta", traceId: "t1", text: "Answer." },
      DONE(),
    ];

    const record = buildTraceRecord(events, "What did I spend?");

    expect(record.trace_id).toBe("t1");
    expect(record.question).toBe("What did I spend?");
    expect(record.stop_reason).toBe("end_turn");
    expect(record.iterations).toBe(2);
    expect(record.errored).toBe(false);
    expect(record.citations_valid).toBe(true);
    expect(record.repaired).toBe(false);
    expect(record.tool_calls).toEqual([{ name: "search_context", duration_ms: 200, is_error: false }]);
    expect(record.input_tokens).toBe(500);
    expect(record.cost_usd).toBe(0.005);
    expect(record.total_duration_ms).toBe(1200);
  });

  it("marks citations invalid and repaired=true when a text_correction fired", () => {
    const events: AgentStreamEvent[] = [
      { type: "text_delta", traceId: "t1", text: "Bad citation [fake_id]." },
      { type: "text_correction", traceId: "t1", text: "Fixed answer.", reason: "removed fake_id" },
      DONE({ repaired: true }),
    ];

    const record = buildTraceRecord(events, "q");
    expect(record.repaired).toBe(true);
    expect(record.citations_valid).toBe(false);
  });

  it("records a fatal error and stops without a done event's data", () => {
    const events: AgentStreamEvent[] = [
      { type: "error", traceId: "t1", message: "401 authentication_error", fatal: true },
    ];

    const record = buildTraceRecord(events, "q");
    expect(record.errored).toBe(true);
    expect(record.error_message).toContain("authentication_error");
    expect(record.stop_reason).toBe("error");
  });

  it("aggregates multiple tool calls across iterations", () => {
    const events: AgentStreamEvent[] = [
      { type: "tool_result", traceId: "t1", toolCallId: "tc1", name: "search_context", isError: false, summary: "ok", durationMs: 100 },
      { type: "tool_result", traceId: "t1", toolCallId: "tc2", name: "query_warehouse", isError: true, summary: "rejected", durationMs: 5 },
      DONE({ iterations: 3 }),
    ];

    const record = buildTraceRecord(events, "q");
    expect(record.tool_calls).toHaveLength(2);
    expect(record.tool_calls[1]!.is_error).toBe(true);
    expect(record.iterations).toBe(3);
  });

  it("falls back to 'unknown' trace_id when no event carries one (defensive, shouldn't happen in practice)", () => {
    const record = buildTraceRecord([], "q");
    expect(record.trace_id).toBe("unknown");
  });

  it("preserves confirmed usage and attempted iterations when a later model request fails", () => {
    const events: AgentStreamEvent[] = [
      { type: "span_start", traceId: "t1", spanId: "llm1", spanType: "llm_call" },
      { type: "span_end", traceId: "t1", spanId: "llm1", spanType: "llm_call", durationMs: 400, isError: false,
        usage: { inputTokens: 1000, outputTokens: 200, cacheCreationInputTokens: 1000, cacheReadInputTokens: 0 } },
      { type: "span_start", traceId: "t1", spanId: "llm2", spanType: "llm_call" },
      { type: "span_end", traceId: "t1", spanId: "llm2", spanType: "llm_call", durationMs: 300, isError: false,
        usage: { inputTokens: 100, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 8000 } },
      { type: "span_start", traceId: "t1", spanId: "llm3", spanType: "llm_call" },
      { type: "span_end", traceId: "t1", spanId: "llm3", spanType: "llm_call", durationMs: 200, isError: true },
      { type: "error", traceId: "t1", message: "Request aborted", fatal: true },
    ];
    const record = buildTraceRecord(events, "q");
    expect(record).toMatchObject({
      errored: true, stop_reason: "error", iterations: 3, error_message: "Request aborted",
      input_tokens: 1100, output_tokens: 300, cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 8000, cost_usd: 0.01395, total_duration_ms: 900,
    });
  });

  it("uses authoritative done totals without double-counting span fallback usage", () => {
    const events: AgentStreamEvent[] = [
      { type: "span_start", traceId: "t1", spanId: "llm1", spanType: "llm_call" },
      { type: "span_end", traceId: "t1", spanId: "llm1", spanType: "llm_call", durationMs: 400, isError: false,
        usage: { inputTokens: 500, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 400 } },
      DONE(),
    ];
    expect(buildTraceRecord(events, "q")).toMatchObject({
      input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 400,
      cost_usd: 0.005, total_duration_ms: 1200, iterations: 2, stop_reason: "end_turn",
    });
  });
});
