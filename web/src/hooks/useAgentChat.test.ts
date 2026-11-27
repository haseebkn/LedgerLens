import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { buildChatHistory, MAX_MESSAGE_CHARS, useAgentChat, type ChatMessage, type StreamFn } from "./useAgentChat.js";
import type { AgentStreamEvent } from "financial-context-agent/streaming-types";

async function* fakeStream(events: AgentStreamEvent[]): AsyncGenerator<AgentStreamEvent> {
  for (const e of events) yield e;
}

// A successful turn must contain an explicit completion event. Disconnects
// can terminate the transport before that event reaches the browser.
const DONE_EVENT: AgentStreamEvent = {
  type: "done",
  traceId: "t1",
  stopReason: "end_turn",
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: 0 },
  totalDurationMs: 0,
  iterations: 1,
  repaired: false,
};

describe("useAgentChat", () => {
  it("appends a user message and a streaming assistant message on send", async () => {
    const streamFn: StreamFn = () => fakeStream([DONE_EVENT]);
    const { result } = renderHook(() => useAgentChat(streamFn));

    await act(async () => {
      await result.current.send("Hello");
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toMatchObject({ role: "user", content: "Hello" });
    expect(result.current.messages[1]).toMatchObject({ role: "assistant", status: "done" });
  });

  it("marks a disconnected partial answer as failed and releases the input", async () => {
    const streamFn: StreamFn = () => fakeStream([{ type: "text_delta", traceId: "t1", text: "partial" }]);
    const { result } = renderHook(() => useAgentChat(streamFn));

    await act(async () => {
      await result.current.send("q");
    });

    expect(result.current.messages[1]).toMatchObject({ status: "error", content: "partial" });
    expect(result.current.messages[1]?.errorMessage).toContain("connection ended");
    expect(result.current.isStreaming).toBe(false);
  });

  it("accumulates text_delta events into the assistant message content", async () => {
    const streamFn: StreamFn = () =>
      fakeStream([
        { type: "text_delta", traceId: "t1", text: "You spent " },
        { type: "text_delta", traceId: "t1", text: "$4.33." },
      ]);
    const { result } = renderHook(() => useAgentChat(streamFn));

    await act(async () => {
      await result.current.send("q");
    });

    expect(result.current.messages[1]?.content).toBe("You spent $4.33.");
  });

  it("replaces content entirely on text_correction", async () => {
    const streamFn: StreamFn = () =>
      fakeStream([
        { type: "text_delta", traceId: "t1", text: "Bad citation [fake]." },
        { type: "text_correction", traceId: "t1", text: "Fixed answer.", reason: "removed fake" },
      ]);
    const { result } = renderHook(() => useAgentChat(streamFn));

    await act(async () => {
      await result.current.send("q");
    });

    expect(result.current.messages[1]?.content).toBe("Fixed answer.");
  });

  it("tracks a tool call through running -> done via tool_call/tool_result", async () => {
    const streamFn: StreamFn = () =>
      fakeStream([
        { type: "tool_call", traceId: "t1", toolCallId: "tc1", name: "search_context", input: { query: "coffee" } },
        { type: "tool_result", traceId: "t1", toolCallId: "tc1", name: "search_context", isError: false, summary: "found 2", durationMs: 120 },
      ]);
    const { result } = renderHook(() => useAgentChat(streamFn));

    await act(async () => {
      await result.current.send("q");
    });

    const timeline = result.current.messages[1]?.toolTimeline;
    expect(timeline).toHaveLength(1);
    expect(timeline?.[0]).toMatchObject({ name: "search_context", status: "done", summary: "found 2" });
  });

  it("tracks spans through running -> done with per-call usage on llm_call", async () => {
    const streamFn: StreamFn = () =>
      fakeStream([
        { type: "span_start", traceId: "t1", spanId: "s1", spanType: "llm_call" },
        {
          type: "span_end",
          traceId: "t1",
          spanId: "s1",
          spanType: "llm_call",
          durationMs: 400,
          isError: false,
          usage: { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 80 },
        },
      ]);
    const { result } = renderHook(() => useAgentChat(streamFn));

    await act(async () => {
      await result.current.send("q");
    });

    const spans = result.current.messages[1]?.spans;
    expect(spans).toHaveLength(1);
    expect(spans?.[0]).toMatchObject({ status: "done", durationMs: 400 });
    expect(spans?.[0]?.usage?.cacheReadInputTokens).toBe(80);
  });

  it("dedupes repeated citation events for the same row_id", async () => {
    const streamFn: StreamFn = () =>
      fakeStream([
        { type: "citation", traceId: "t1", rowId: "plaid_a", source: "plaid" },
        { type: "citation", traceId: "t1", rowId: "plaid_a", source: "plaid" },
      ]);
    const { result } = renderHook(() => useAgentChat(streamFn));

    await act(async () => {
      await result.current.send("q");
    });

    expect(result.current.messages[1]?.citedRowIds).toEqual(["plaid_a"]);
  });

  it("marks the assistant message errored on a fatal error event", async () => {
    const streamFn: StreamFn = () =>
      fakeStream([{ type: "error", traceId: "t1", message: "401 authentication_error", fatal: true }]);
    const { result } = renderHook(() => useAgentChat(streamFn));

    await act(async () => {
      await result.current.send("q");
    });

    expect(result.current.messages[1]).toMatchObject({ status: "error", errorMessage: "401 authentication_error" });
  });

  it("marks the assistant message errored when the stream generator throws", async () => {
    const streamFn: StreamFn = async function* () {
      yield* [];
      throw new Error("network exploded");
    };
    const { result } = renderHook(() => useAgentChat(streamFn));

    await act(async () => {
      await result.current.send("q");
    });

    expect(result.current.messages[1]).toMatchObject({ status: "error", errorMessage: "network exploded" });
  });

  it("stores usage and marks done on the done event", async () => {
    const streamFn: StreamFn = () =>
      fakeStream([
        {
          type: "done",
          traceId: "t1",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: 0.001 },
          totalDurationMs: 500,
          iterations: 1,
          repaired: false,
        },
      ]);
    const { result } = renderHook(() => useAgentChat(streamFn));

    await act(async () => {
      await result.current.send("q");
    });

    expect(result.current.messages[1]).toMatchObject({ status: "done" });
    expect(result.current.messages[1]?.usage?.estimatedCostUsd).toBe(0.001);
  });

  it("sets isStreaming true while sending and false once complete", async () => {
    const { result } = renderHook(() => useAgentChat(() => fakeStream([])));
    expect(result.current.isStreaming).toBe(false);

    const sendPromise = act(async () => {
      await result.current.send("q");
    });
    await sendPromise;

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
  });

  it("passes prior completed messages as history on the next send", async () => {
    const receivedHistories: unknown[] = [];
    const streamFn: StreamFn = (_msg, history) => {
      receivedHistories.push(history);
      return fakeStream([{ type: "text_delta", traceId: "t1", text: "answer" }, DONE_EVENT]);
    };
    const { result } = renderHook(() => useAgentChat(streamFn));

    await act(async () => {
      await result.current.send("first");
    });
    await act(async () => {
      await result.current.send("second");
    });

    expect(receivedHistories[0]).toEqual([]);
    expect(receivedHistories[1]).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("ignores simultaneous sends before React has rendered the busy state", async () => {
    const streamFn = vi.fn<StreamFn>(() => fakeStream([DONE_EVENT]));
    const { result } = renderHook(() => useAgentChat(streamFn));
    await act(async () => {
      await Promise.all([result.current.send("first"), result.current.send("duplicate")]);
    });
    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(result.current.messages).toHaveLength(2);
  });

  it("rejects empty and oversized input without starting a request", async () => {
    const streamFn = vi.fn<StreamFn>(() => fakeStream([DONE_EVENT]));
    const { result } = renderHook(() => useAgentChat(streamFn));
    await act(async () => {
      await result.current.send("   ");
      await result.current.send("x".repeat(MAX_MESSAGE_CHARS + 1));
    });
    expect(streamFn).not.toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(0);
  });

  it("keeps recoverable errors from poisoning a successfully completed answer", async () => {
    const { result } = renderHook(() => useAgentChat(() => fakeStream([
      { type: "error", traceId: "t1", message: "retrying", fatal: false },
      { type: "text_delta", traceId: "t1", text: "Recovered" },
      DONE_EVENT,
    ])));
    await act(async () => { await result.current.send("q"); });
    expect(result.current.messages[1]).toMatchObject({ status: "done", content: "Recovered" });
    expect(result.current.messages[1]?.errorMessage).toBeUndefined();
  });

  it("stops unfinished tools and spans when the transport closes", async () => {
    const { result } = renderHook(() => useAgentChat(() => fakeStream([
      { type: "tool_call", traceId: "t1", toolCallId: "tc1", name: "search_context", input: {} },
      { type: "span_start", traceId: "t1", spanId: "s1", spanType: "tool_exec" },
    ])));
    await act(async () => { await result.current.send("q"); });
    expect(result.current.messages[1]?.toolTimeline[0]?.status).toBe("error");
    expect(result.current.messages[1]?.spans[0]?.status).toBe("error");
  });

  it("aborts the active transport on stop and unmount", async () => {
    const signals: AbortSignal[] = [];
    const streamFn: StreamFn = async function* (_message, _history, signal) {
      signals.push(signal!);
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      yield* [];
    };
    const { result, unmount } = renderHook(() => useAgentChat(streamFn));
    let sending: Promise<void>;
    act(() => { sending = result.current.send("first"); });
    await act(async () => { result.current.stop(); await sending; });
    expect(signals[0]?.aborted).toBe(true);
    expect(result.current.messages[1]).toMatchObject({ status: "stopped", errorMessage: expect.stringContaining("Stopped") });
    expect(result.current.isStreaming).toBe(false);
    // A stopped answer is not trusted history for the next turn.
    expect(buildChatHistory(result.current.messages, "next")).toEqual([]);
    act(() => { sending = result.current.send("second"); });
    await act(async () => { unmount(); await sending; });
    expect(signals[1]?.aborted).toBe(true);
  });
});

describe("citation warnings", () => {
  it("collects warnings on the assistant message", async () => {
    const streamFn: StreamFn = () => fakeStream([
      { type: "text_delta", traceId: "t1", text: "Rent was $900." },
      { type: "citation_warning", traceId: "t1", figure: "$900", sentence: "Rent was $900.", reason: "uncited", citedIds: [] },
      DONE_EVENT,
    ]);
    const { result } = renderHook(() => useAgentChat(streamFn));
    await act(async () => { await result.current.send("rent?"); });
    expect(result.current.messages[1]).toMatchObject({
      status: "done", citationWarnings: [{ figure: "$900", reason: "uncited" }],
    });
  });
});

describe("bounded chat history", () => {
  const turn = (index: number, content = `message ${index}`): ChatMessage[] => ["user", "assistant"].map((role) => ({
    id: `${index}-${role}`, role: role as ChatMessage["role"], content, status: "done",
    toolTimeline: [], spans: [], citedRowIds: [],
  }));

  it("sends the most recent 20 complete turns", () => {
    const messages = Array.from({ length: 25 }, (_, i) => turn(i)).flat();
    const history = buildChatHistory(messages, "next");
    expect(history).toHaveLength(40);
    expect(history[0]?.content).toBe("message 5");
    expect(history[39]?.content).toBe("message 24");
  });

  it("omits failed, blank and oversized answers as entire pairs", () => {
    const failed = turn(1);
    failed[1]!.status = "error";
    const blank = turn(2);
    blank[1]!.content = "";
    const huge = turn(3);
    huge[1]!.content = "x".repeat(8001);
    expect(buildChatHistory([...turn(0), ...failed, ...blank, ...huge], "next")).toEqual([
      { role: "user", content: "message 0" }, { role: "assistant", content: "message 0" },
    ]);
  });

  it("respects both combined character and encoded body limits", () => {
    for (const content of ["x".repeat(8000), "界".repeat(8000), "\u0000".repeat(8000)]) {
      const messages = Array.from({ length: 25 }, (_, i) => turn(i, content)).flat();
      const history = buildChatHistory(messages, content);
      expect(history.length % 2).toBe(0);
      expect(history.reduce((sum, item) => sum + item.content.length, content.length)).toBeLessThanOrEqual(64000);
      expect(new TextEncoder().encode(JSON.stringify({ message: content, history })).byteLength).toBeLessThanOrEqual(128 * 1024);
    }
  });
});
