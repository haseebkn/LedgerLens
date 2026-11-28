import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentStreamEvent } from "financial-context-agent/streaming-types";
import App from "./App.js";

vi.mock("./components/MetricsView.js", () => ({ MetricsView: () => <p>Metrics view</p> }));
vi.mock("./components/EvalsView.js", () => ({ EvalsView: () => <p>Evals view</p> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A /api/chat response that streams one answer as SSE frames. */
function sseResponse(events: AgentStreamEvent[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}

`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

describe("workspace navigation", () => {
  it("keeps the conversation draft mounted when visiting metrics", () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<App />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "My next question" } });
    fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("My next question");
  });

  it("keeps sent messages and their answers after visiting other tabs", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const fetchMock = vi.fn(async () => sseResponse([
      { type: "text_delta", traceId: "t1", text: "You spent $12 on coffee." },
      {
        type: "done", traceId: "t1", stopReason: "end_turn", iterations: 1, repaired: false, totalDurationMs: 5,
        usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: 0 },
      },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Coffee spend?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("You spent $12 on coffee.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Metrics" }));
    fireEvent.click(screen.getByRole("tab", { name: "Evals" }));
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));

    expect(screen.getByText("Coffee spend?")).toBeInTheDocument();
    expect(screen.getByText("You spent $12 on coffee.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports arrow-key tab selection and focus", () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<App />);
    const chat = screen.getByRole("tab", { name: "Chat" });
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
