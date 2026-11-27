import type { AgentStreamEvent } from "../streaming-types.js";
import type { TraceRecord } from "./trace-writer.js";
import { env } from "../config.js";
import { addUsage, emptyUsage } from "./usage.js";

/**
 * Pure reducer over one turn's full event list -> a persistable TraceRecord.
 * Kept separate from trace-writer.ts's file I/O and from the route handler
 * so it can be tested with plain arrays of events, no server or filesystem
 * involved.
 */
export function buildTraceRecord(events: AgentStreamEvent[], question: string, model: string = env.AGENT_MODEL): TraceRecord {
  const toolCalls: TraceRecord["tool_calls"] = [];
  let stopReason = "unknown";
  let iterations = 0;
  let repaired = false;
  let errored = false;
  let errorMessage: string | null = null;
  let citationsValid = true;
  let usage = emptyUsage();
  let totalDurationMs = 0;
  let receivedDone = false;
  let spanUsage = emptyUsage();
  let spanDurationMs = 0;
  let attemptedIterations = 0;
  const traceId = events.find((e) => "traceId" in e)?.traceId ?? "unknown";

  for (const event of events) {
    switch (event.type) {
      case "span_start":
        if (event.spanType === "llm_call") attemptedIterations++;
        break;
      case "span_end":
        spanDurationMs += event.durationMs;
        if (event.spanType === "llm_call" && event.usage) {
          spanUsage = addUsage(spanUsage, {
            input_tokens: event.usage.inputTokens,
            output_tokens: event.usage.outputTokens,
            cache_creation_input_tokens: event.usage.cacheCreationInputTokens,
            cache_read_input_tokens: event.usage.cacheReadInputTokens,
          }, model);
        }
        break;
      case "tool_result":
        toolCalls.push({ name: event.name, duration_ms: event.durationMs, is_error: event.isError });
        break;
      case "text_correction":
        repaired = true;
        // citations_valid tracks whether the ORIGINAL streamed answer had a
        // valid citation set, not whether the post-repair text does — a
        // text_correction only ever fires because validateCitations()
        // found an unsupported citation in that original answer.
        citationsValid = false;
        break;
      case "error":
        if (event.fatal) {
          errored = true;
          errorMessage = event.message;
        }
        break;
      case "done":
        receivedDone = true;
        stopReason = event.stopReason;
        iterations = event.iterations;
        repaired = repaired || event.repaired;
        usage = event.usage;
        totalDurationMs = event.totalDurationMs;
        break;
    }
  }

  if (!receivedDone) {
    // Failed/cancelled turns have no done event. Preserve confirmed usage
    // from completed LLM spans and count every attempted iteration. Tokens
    // consumed by an interrupted request are unknown, so these costs are a
    // lower bound, not an invented estimate for its unfinished generation.
    // Duration similarly covers measured, closed spans only.
    usage = spanUsage;
    iterations = attemptedIterations;
    totalDurationMs = spanDurationMs;
    if (errored) stopReason = "error";
  }

  return {
    trace_id: traceId,
    question,
    stop_reason: stopReason,
    iterations,
    repaired,
    errored,
    error_message: errorMessage,
    citations_valid: citationsValid,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_creation_input_tokens: usage.cacheCreationInputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
    cost_usd: usage.estimatedCostUsd,
    total_duration_ms: totalDurationMs,
    tool_calls: toolCalls,
  };
}
