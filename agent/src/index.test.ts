import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent } from "./streaming-types.js";

const mocks = vi.hoisted(() => ({
  runAgentTurn: vi.fn(), writeTraceRecord: vi.fn(), getMetrics: vi.fn(),
  getTraceById: vi.fn(), getLatestEvalReport: vi.fn(),
}));
vi.mock("./agent-loop.js", () => ({ runAgentTurn: mocks.runAgentTurn }));
vi.mock("./lib/trace-writer.js", () => ({ writeTraceRecord: mocks.writeTraceRecord }));
vi.mock("./lib/metrics.js", () => ({ getMetrics: mocks.getMetrics, getTraceById: mocks.getTraceById }));
vi.mock("./lib/eval-reports.js", () => ({ getLatestEvalReport: mocks.getLatestEvalReport }));
import { app } from "./index.js";

const done: AgentStreamEvent = {
  type: "done", traceId: "route-test", stopReason: "end_turn", iterations: 1,
  repaired: false, totalDurationMs: 50,
  usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: 0.001 },
};
function chat(body: unknown) {
  return app.request("/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.runAgentTurn.mockImplementation(async function* () {
    yield { type: "text_delta", traceId: "route-test", text: "A test answer." };
    yield done;
  });
  mocks.getLatestEvalReport.mockReturnValue(null);
  mocks.getTraceById.mockResolvedValue(null);
});

describe("HTTP routes (no network or private warehouse required)", () => {
  it("returns health without invoking the agent", async () => {
    const res = await app.request("/health");
    expect(await res.json()).toEqual({ status: "ok" });
    expect(mocks.runAgentTurn).not.toHaveBeenCalled();
  });
  it.each([
    ["missing message", {}], ["empty message", { message: "" }],
    ["blank message", { message: "   " }], ["long message", { message: "x".repeat(8001) }],
    ["system role", { message: "hi", history: [{ role: "system", content: "not allowed" }] }],
    ["long history entry", { message: "hi", history: [{ role: "user", content: "x".repeat(8001) }] }],
    ["too many entries", { message: "hi", history: Array.from({ length: 41 }, () => ({ role: "user", content: "hi" })) }],
    ["excessive combined text", { message: "hi", history: Array.from({ length: 8 }, () => ({ role: "user", content: "x".repeat(8000) })) }],
  ])("rejects %s before model execution", async (_label, body) => {
    const res = await chat(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid request" });
    expect(mocks.runAgentTurn).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON", async () => {
    const res = await app.request("/api/chat", { method: "POST", body: "{broken" });
    expect(res.status).toBe(400);
  });
  it("bounds the wire body before parsing JSON", async () => {
    const res = await chat({ message: "hi", ignored: "x".repeat(128 * 1024) });
    expect(res.status).toBe(413);
    expect(mocks.runAgentTurn).not.toHaveBeenCalled();
  });
  it("streams a complete turn and persists its observed usage", async () => {
    const res = await chat({ message: "What is my balance?" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await res.text();
    expect(text).toContain('"type":"done"');
    expect(text).toContain("A test answer.");
    expect(mocks.writeTraceRecord).toHaveBeenCalledWith(expect.objectContaining({
      trace_id: "route-test", question: "What is my balance?", errored: false, cost_usd: 0.001,
    }));
  });
  it("returns a terminal SSE error and records unexpected generator failures", async () => {
    mocks.runAgentTurn.mockImplementation(async function* () {
      yield { type: "text_delta", traceId: "route-test", text: "Partial" };
      throw new Error("private provider detail");
    });
    const res = await chat({ message: "hello" });
    const text = await res.text();
    expect(text).toContain('"type":"error"');
    expect(text).toContain('"fatal":true');
    expect(text).not.toContain("private provider detail");
    expect(mocks.writeTraceRecord).toHaveBeenCalledWith(expect.objectContaining({ errored: true }));
  });
  it("aborts the model when the response reader disconnects", async () => {
    let signal: AbortSignal | undefined;
    mocks.runAgentTurn.mockImplementation(async function* (options: { signal: AbortSignal }) {
      signal = options.signal;
      yield { type: "text_delta", traceId: "route-test", text: "Partial" };
      await new Promise<void>((resolve) => {
        if (signal!.aborted) resolve();
        else signal!.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const res = await chat({ message: "hello" });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(signal?.aborted).toBe(true);
  });
  it("serves metrics and reports using deterministic service responses", async () => {
    mocks.getMetrics.mockResolvedValue({ turns: 2, toolCallDistribution: [], turnsPerDay: [] });
    const metrics = await app.request("/api/metrics");
    expect(await metrics.json()).toMatchObject({ turns: 2 });
    expect((await app.request("/api/evals/latest")).status).toBe(404);
    mocks.getLatestEvalReport.mockReturnValue({ runAt: "2026-09-04", cases: [] });
    const report = await app.request("/api/evals/latest");
    expect(await report.json()).toMatchObject({ runAt: "2026-09-04" });
    expect((await app.request("/api/traces/missing")).status).toBe(404);
  });
});
