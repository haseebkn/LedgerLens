import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentStreamEvent } from "financial-context-agent/streaming-types";
import App from "./App.js";
import { getSession, setSession } from "./lib/api.js";

vi.mock("./components/MetricsView.js", () => ({ MetricsView: () => <p>Metrics view</p> }));
vi.mock("./components/EvalsView.js", () => ({ EvalsView: () => <p>Evals view</p> }));

const DONE: AgentStreamEvent = {
  type: "done", traceId: "t1", stopReason: "end_turn", iterations: 1, repaired: false, totalDurationMs: 5,
  usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: 0 },
};

/** A /api/chat response that streams one answer as SSE frames. */
function sseResponse(events: AgentStreamEvent[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Routes fetch by path; `chat` answers POST /api/chat. */
function stubApi(options: {
  authRequired?: boolean;
  chat?: (init?: RequestInit) => Response;
} = {}) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    if (path === "/api/auth/config") return json({ authRequired: options.authRequired ?? false, demoAvailable: true });
    if (path === "/api/auth/demo") return json({ accessToken: "demo-token", expiresIn: 3600 });
    if (path === "/api/chat") return options.chat ? options.chat(init) : sseResponse([DONE]);
    return json({ error: "not stubbed" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  setSession(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null);
});

describe("workspace navigation", () => {
  it("keeps the conversation draft mounted when visiting metrics", async () => {
    stubApi();
    render(<App />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), { target: { value: "My next question" } });
    fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("My next question");
  });

  it("keeps sent messages and their answers after visiting other tabs", async () => {
    const { calls } = stubApi({
      chat: () => sseResponse([{ type: "text_delta", traceId: "t1", text: "You spent $12 on coffee." }, DONE]),
    });
    render(<App />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), { target: { value: "Coffee spend?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("You spent $12 on coffee.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
    fireEvent.click(screen.getByRole("tab", { name: "Evals" }));
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));

    expect(screen.getByText("Coffee spend?")).toBeInTheDocument();
    expect(screen.getByText("You spent $12 on coffee.")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/api/chat")).toHaveLength(1);
  });

  it("supports arrow-key tab selection and focus", async () => {
    stubApi();
    render(<App />);
    const chat = await screen.findByRole("tab", { name: "Chat" });
    chat.focus();
    fireEvent.keyDown(chat, { key: "ArrowRight" });
    const metrics = screen.getByRole("tab", { name: "Metrics" });
    expect(metrics).toHaveFocus();
    expect(metrics).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Metrics" })).toBeInTheDocument();
    fireEvent.keyDown(metrics, { key: "End" });
    expect(screen.getByRole("tab", { name: "Evals" })).toHaveFocus();
  });
});

describe("sign-in", () => {
  it("shows the sign-in screen when the server requires it, and needs no sign-out locally", async () => {
    stubApi({ authRequired: true });
    render(<App />);
    expect(await screen.findByRole("button", { name: "Try the demo" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    cleanup();
    stubApi({ authRequired: false });
    render(<App />);
    await screen.findByRole("textbox", { name: "Message" });
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("signs in as the demo user and sends its token with chat requests", async () => {
    const { calls } = stubApi({ authRequired: true });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Try the demo" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await vi.waitFor(() => expect(calls.some((c) => c.path === "/api/chat")).toBe(true));
    const chat = calls.find((c) => c.path === "/api/chat")!;
    expect(new Headers(chat.init?.headers).get("Authorization")).toBe("Bearer demo-token");
    expect(getSession()?.accessToken).toBe("demo-token");
  });

  it("returns to the sign-in screen when the session is rejected", async () => {
    stubApi({ authRequired: true, chat: () => json({ error: "Your session has expired. Sign in again." }, 401) });
    setSession({ accessToken: "stale", expiresAt: Date.now() + 3_600_000 });
    render(<App />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: "Try the demo" })).toBeInTheDocument();
    expect(getSession()).toBeNull();
  });

  it("shows the server's limit message when a turn is refused", async () => {
    stubApi({
      chat: () => json({ error: "You've sent 20 questions in the last hour. Try again in 12 minutes.", reason: "turns_per_hour" }, 429),
    });
    render(<App />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/20 questions in the last hour/)).toBeInTheDocument();
  });

  it("signs out", async () => {
    stubApi({ authRequired: true });
    setSession({ accessToken: "t", expiresAt: Date.now() + 3_600_000 });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Try the demo" })).toBeInTheDocument();
  });
});
