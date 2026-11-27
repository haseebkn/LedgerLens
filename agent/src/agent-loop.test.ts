import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent } from "./streaming-types.js";

const { toolRunner, testEnv } = vi.hoisted(() => ({
  toolRunner: vi.fn(),
  testEnv: {
    ANTHROPIC_API_KEY: "test-placeholder",
    AGENT_MODEL: "claude-sonnet-5",
    USER_TIME_ZONE: "America/St_Johns",
    MAX_TOOL_ITERATIONS: 8,
    TASK_BUDGET_TOKENS: 20000,
  },
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { beta = { messages: { toolRunner } }; },
}));
vi.mock("./config.js", () => ({ env: testEnv }));
vi.mock("./tools/index.js", () => ({ tools: [] }));
import { runAgentTurn } from "./agent-loop.js";

function makeStream(options: {
  texts?: string[];
  tool?: boolean;
  usage?: Record<string, number>;
  waitAfterText?: Promise<void>;
} = {}) {
  const texts = options.texts ?? [];
  const message = {
    content: [
      ...texts.map((text) => ({ type: "text", text })),
      ...(options.tool ? [{ type: "tool_use", id: "tc1", name: "query_warehouse", input: {} }] : []),
    ],
    stop_reason: options.tool ? "tool_use" : "end_turn",
    usage: options.usage ?? { input_tokens: 100, output_tokens: 20 },
  };
  const finalMessage = vi.fn(async () => {
    await options.waitAfterText;
    return message;
  });
  const abort = vi.fn();
  return {
    abort,
    finalMessage,
    async *[Symbol.asyncIterator]() {
      for (const text of texts) {
        yield { type: "content_block_start", content_block: { type: "text", text: "" } };
        yield { type: "content_block_delta", delta: { type: "text_delta", text } };
      }
      await options.waitAfterText;
    },
  };
}

function configureRunner(streams: ReturnType<typeof makeStream>[], content: unknown = '{"result_id":"computed_query_real"}') {
  const generateToolResponse = vi.fn(async () => ({
    content: [{ type: "tool_result", tool_use_id: "tc1", content }],
  }));
  toolRunner.mockReturnValue({
    generateToolResponse,
    async *[Symbol.asyncIterator]() { yield* streams; },
  });
  return generateToolResponse;
}

async function collect(signal?: AbortSignal) {
  const events: AgentStreamEvent[] = [];
  for await (const event of runAgentTurn({ history: [], userMessage: "Total?", signal })) events.push(event);
  return events;
}

beforeEach(() => {
  toolRunner.mockReset();
  testEnv.MAX_TOOL_ITERATIONS = 8;
  testEnv.TASK_BUDGET_TOKENS = 20000;
});

describe("agent loop with deterministic SDK streams", () => {
  it("delivers the first text while the model is still generating", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stream = makeStream({ texts: ["First words"], waitAfterText: gate });
    configureRunner([stream]);
    const turn = runAgentTurn({ history: [], userMessage: "Hello" });
    expect((await turn.next()).value?.type).toBe("span_start");
    try {
      const next = await Promise.race([
        turn.next(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Text was buffered")), 500)),
      ]);
      expect(next.value).toMatchObject({ type: "text_delta", text: "First words" });
      expect(stream.finalMessage).not.toHaveBeenCalled();
    } finally {
      release();
      for await (const _ of turn) { /* finish the stream */ }
    }
  });

  it("keeps streamed paragraph boundaries and repairs only unsupported citations", async () => {
    configureRunner([
      makeStream({ texts: ["Checking."], tool: true }),
      makeStream({ texts: ["Total is $12 [computed_query_real].", "Source [plaid_fake]."] }),
    ]);
    const events = await collect();
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
    expect(text).toBe("Checking.\n\nTotal is $12 [computed_query_real].\nSource [plaid_fake].");
    expect(events.find((e) => e.type === "text_correction")).toMatchObject({
      text: "Checking.\n\nTotal is $12 [computed_query_real].\nSource.",
    });
    expect(events.filter((e) => e.type === "citation")).toMatchObject([{ rowId: "computed_query_real" }]);
  });

  it("counts cache tokens toward the budget and streams a terminal explanation", async () => {
    const executeTools = configureRunner([makeStream({
      tool: true,
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 20000 },
    })]);
    const events = await collect();
    expect(executeTools).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events.find((e) => e.type === "text_delta")).toMatchObject({ text: expect.stringContaining("working budget") });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "task_budget_reached", iterations: 1 });
  });

  it("does not execute unused tools at the iteration cap", async () => {
    testEnv.MAX_TOOL_ITERATIONS = 1;
    const executeTools = configureRunner([makeStream({ texts: ["Checking."], tool: true })]);
    const events = await collect();
    expect(executeTools).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "max_iterations_reached" });
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text).join(""))
      .toContain("Checking.\n\nI've reached the tool iteration limit");
  });

  it("aborts the active SDK stream and does not start a tool batch after disconnect", async () => {
    const controller = new AbortController();
    const stream = makeStream({ texts: ["Checking."], tool: true });
    const executeTools = configureRunner([stream]);
    const events: AgentStreamEvent[] = [];
    for await (const event of runAgentTurn({ history: [], userMessage: "Total?", signal: controller.signal })) {
      events.push(event);
      if (event.type === "text_delta") controller.abort();
    }
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(executeTools).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "error", fatal: true });
    const starts = events.filter((e) => e.type === "span_start").map((e) => e.spanId);
    const ends = events.filter((e) => e.type === "span_end").map((e) => e.spanId);
    expect(ends).toEqual(starts);
  });

  it("does not open an SDK stream for an already-cancelled request", async () => {
    const stream = makeStream();
    configureRunner([stream]);
    const events = await collect(AbortSignal.abort());
    expect(stream.finalMessage).not.toHaveBeenCalled();
    expect(events).toMatchObject([{ type: "error", fatal: true }]);
  });

  it("handles cancellation while the initial span event is being delivered", async () => {
    const controller = new AbortController();
    const stream = makeStream();
    configureRunner([stream]);
    const events: AgentStreamEvent[] = [];
    for await (const event of runAgentTurn({ history: [], userMessage: "Total?", signal: controller.signal })) {
      events.push(event);
      if (event.type === "span_start") controller.abort();
    }
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.finalMessage).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "error", fatal: true });
  });
});
