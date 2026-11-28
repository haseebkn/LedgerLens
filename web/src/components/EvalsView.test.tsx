import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EvalsView } from "./EvalsView.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const report = {
  runAt: "2026-08-26T01:34:34.845Z", model: "test-model", totalCases: 1,
  categoryBreakdown: {},
  aggregate: { toolChoiceAccuracy: 1, meanRecall: 1, meanJudgeScore: 5, meanJudgeSpread: 0, maxJudgeSpread: 0, totalCostUsd: 0.48, p50DurationMs: 500, p95DurationMs: 1000 },
  results: [{ id: "citation-problem", category: "retrieval", question: "Question?", toolChoiceScore: 1, recallScore: 1, judgeScore: 5, judgeSpread: 0, judgeExplanation: "Citation is unsupported.", errored: false, citationsValid: false }],
};

describe("eval evidence labels", () => {
  it("labels legacy latency honestly and shows citation-only failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => report }));
    render(<EvalsView />);
    expect(await screen.findByText(/Agent cost.*judge excluded/)).toBeInTheDocument();
    expect(screen.getByText("Agent + judge p50 / p95")).toBeInTheDocument();
    expect(screen.getByText(/Historical report: latency includes/)).toBeInTheDocument();
    expect(screen.getByText("citation-problem")).toBeInTheDocument();
    expect(screen.getByText("Citation check flagged a problem.")).toBeInTheDocument();
  });

  it("labels new reports as agent latency without the historical warning", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...report, metadata: { latencyScope: "agent_only", costScope: "agent_only", judgeN: 3 } }) }));
    render(<EvalsView />);
    expect(await screen.findByText("Agent p50 / p95")).toBeInTheDocument();
    expect(screen.queryByText(/Historical report/)).not.toBeInTheDocument();
  });
});
