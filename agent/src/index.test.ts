import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent } from "./streaming-types.js";

const mocks = vi.hoisted(() => ({
  runAgentTurn: vi.fn(), writeTraceRecord: vi.fn(), getMetrics: vi.fn(),
  getTraceById: vi.fn(), getLatestEvalReport: vi.fn(), getRowById: vi.fn(), checkReadiness: vi.fn(),
}));
vi.mock("./lib/readiness.js", () => ({ checkReadiness: mocks.checkReadiness }));
vi.mock("./agent-loop.js", () => ({ runAgentTurn: mocks.runAgentTurn }));
vi.mock("./lib/trace-writer.js", () => ({ writeTraceRecord: mocks.writeTraceRecord }));
vi.mock("./lib/metrics.js", () => ({ getMetrics: mocks.getMetrics, getTraceById: mocks.getTraceById }));
vi.mock("./lib/eval-reports.js", () => ({ getLatestEvalReport: mocks.getLatestEvalReport }));
vi.mock("./lib/rows.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/rows.js")>()),
  getRowById: mocks.getRowById,
}));
import { app, createApp } from "./index.js";
import { UsageLimiter } from "./lib/usage-limits.js";

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
  it("serves health without I/O, also under /api for the public ALB", async () => {
    for (const path of ["/health", "/api/health"]) {
      expect(await (await app.request(path)).json()).toEqual({ status: "ok" });
    }
    expect(mocks.checkReadiness).not.toHaveBeenCalled();
  });
  it("reports readiness as 200 or 503 with per-dependency checks", async () => {
    mocks.checkReadiness.mockResolvedValue({ ready: true, checks: { warehouse: "ok", retrieval: "ok" } });
    const ok = await app.request("/api/ready");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "ready", checks: { warehouse: "ok", retrieval: "ok" } });
    mocks.checkReadiness.mockResolvedValue({ ready: false, checks: { warehouse: "failed", retrieval: "ok" } });
    const down = await app.request("/ready");
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ status: "not_ready", checks: { warehouse: "failed" } });
  });
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
  it("serves a cited row, and rejects malformed ids before touching the warehouse", async () => {
    mocks.getRowById.mockResolvedValue({ kind: "source", rowId: "plaid_tx1", source: "plaid", payload: { amount: 4.5 } });
    const ok = await app.request("/api/rows/plaid_tx1");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ kind: "source", payload: { amount: 4.5 } });

    const bad = await app.request(`/api/rows/${encodeURIComponent("plaid_x' OR 1=1")}`);
    expect(bad.status).toBe(400);
    expect(mocks.getRowById).toHaveBeenCalledTimes(1);

    mocks.getRowById.mockResolvedValue(null);
    const gone = await app.request("/api/rows/computed_query_abc");
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { error: string }).error).toContain("no longer available");

    mocks.getRowById.mockRejectedValue(new Error("IO Error: /private/path/financial_engine.db"));
    const failed = await app.request("/api/rows/plaid_tx1");
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("/private/path");
  });
  it("records a disconnected turn as client_aborted", async () => {
    mocks.runAgentTurn.mockImplementation(async function* (options: { signal: AbortSignal }) {
      yield { type: "text_delta", traceId: "route-test", text: "Partial" };
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const res = await chat({ message: "hello" });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(mocks.writeTraceRecord).toHaveBeenCalled());
    expect(mocks.writeTraceRecord).toHaveBeenCalledWith(expect.objectContaining({ stop_reason: "client_aborted" }));
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

describe("sign-in and limits (AUTH_MODE=cognito)", () => {
  const verify = async (token: string) => {
    if (!token.startsWith("valid-")) throw new Error("invalid token");
    return { sub: token.slice("valid-".length) };
  };
  const limits = { turnsPerHour: 20, userTokensPerDay: 1_000_000, globalTokensPerDay: 10_000_000 };
  const as = (user: string) => ({ Authorization: `Bearer valid-${user}` });
  const post = (target: ReturnType<typeof createApp>, headers: Record<string, string> = {}) =>
    target.request("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ message: "hi" }),
    });

  it.each([
    ["POST", "/api/chat"], ["GET", "/api/traces/abc"], ["GET", "/api/metrics"],
    ["GET", "/api/rows/plaid_1"], ["GET", "/api/evals/latest"],
  ])("rejects an unauthenticated %s %s with 401", async (method, path) => {
    const secured = createApp({ authMode: "cognito", verify, limiter: new UsageLimiter(limits) });
    const res = await secured.request(path, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    expect(res.status).toBe(401);
    expect(mocks.runAgentTurn).not.toHaveBeenCalled();
  });

  it("leaves health, readiness and sign-in discovery public", async () => {
    mocks.checkReadiness.mockResolvedValue({ ready: true, checks: { warehouse: "ok", retrieval: "ok" } });
    const secured = createApp({ authMode: "cognito", verify, limiter: new UsageLimiter(limits) });
    expect((await secured.request("/api/health")).status).toBe(200);
    expect((await secured.request("/api/ready")).status).toBe(200);
    expect(await (await secured.request("/api/auth/config")).json()).toEqual({ authRequired: true, demoAvailable: false });
    expect((await secured.request("/api/auth/demo", { method: "POST" })).status).toBe(404);
  });

  it("answers a signed-in user and refuses the 21st turn in an hour with a clear 429", async () => {
    const secured = createApp({ authMode: "cognito", verify, limiter: new UsageLimiter(limits) });
    for (let i = 0; i < 20; i++) {
      const res = await post(secured, as("alice"));
      expect(res.status).toBe(200);
      await res.text();
    }
    const limited = await post(secured, as("alice"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ reason: "turns_per_hour", error: expect.stringContaining("20 questions") });
    // Another user's limit is separate.
    expect((await post(secured, as("bob"))).status).toBe(200);
  });

  it("charges the tokens a turn used against the user's daily budget", async () => {
    const limiter = new UsageLimiter({ ...limits, userTokensPerDay: 15 });
    const secured = createApp({ authMode: "cognito", verify, limiter });
    await (await post(secured, as("carol"))).text();
    const refused = await post(secured, as("carol"));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ reason: "user_tokens_per_day" });
  });

  it("signs in the demo user server-side without exposing its password", async () => {
    const demoSignIn = vi.fn(async () => ({ accessToken: "valid-demo", expiresIn: 3600 }));
    const secured = createApp({ authMode: "cognito", verify, limiter: new UsageLimiter(limits), demoSignIn });
    expect(await (await secured.request("/api/auth/config")).json()).toMatchObject({ demoAvailable: true });
    const res = await secured.request("/api/auth/demo", { method: "POST" });
    expect(await res.json()).toEqual({ accessToken: "valid-demo", expiresIn: 3600 });
    demoSignIn.mockRejectedValueOnce(new Error("NotAuthorizedException for demo/hunter2"));
    const failed = await secured.request("/api/auth/demo", { method: "POST" });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("hunter2");
  });

  it("sets security headers on API responses", async () => {
    const res = await app.request("/api/health");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});
