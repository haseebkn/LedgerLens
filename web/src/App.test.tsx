import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import App from "./App.js";

vi.mock("./components/MetricsView.js", () => ({ MetricsView: () => <p>Metrics view</p> }));
vi.mock("./components/EvalsView.js", () => ({ EvalsView: () => <p>Evals view</p> }));

afterEach(cleanup);

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
