import { describe, expect, it } from "vitest";
import { buildReport, evaluateGate, formatReportMarkdown, hashGoldenSet, DEFAULT_THRESHOLDS } from "./report.js";
import type { CaseResult, EvalRunMetadata, GoldenCase } from "./types.js";

const METADATA: EvalRunMetadata = {
  goldenSetHash: "test-case-definition-hash", scorerVersion: "2", judgeN: 3,
  scope: "full", costScope: "agent_only", latencyScope: "agent_only",
};

function makeResult(overrides: Partial<CaseResult>): CaseResult {
  return {
    id: "c1",
    category: "retrieval",
    question: "q",
    answerText: "a",
    toolCalls: [],
    seenRowIds: [],
    errored: false,
    durationMs: 100,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
    toolChoiceScore: 1,
    recallScore: 1,
    judgeScore: 5,
    judgeSpread: 0,
    judgeExplanation: "good",
    citationsValid: true,
    ...overrides,
  };
}

describe("buildReport", () => {
  it("computes per-category and aggregate stats", () => {
    const results = [
      makeResult({ id: "r1", category: "retrieval", toolChoiceScore: 1, recallScore: 1, judgeScore: 5 }),
      makeResult({ id: "r2", category: "retrieval", toolChoiceScore: 0, recallScore: 0.5, judgeScore: 3 }),
      makeResult({ id: "a1", category: "aggregation", toolChoiceScore: 1, recallScore: 1, judgeScore: 4 }),
    ];
    const report = buildReport(results, "claude-opus-5");

    expect(report.totalCases).toBe(3);
    expect(report.categoryBreakdown.retrieval.count).toBe(2);
    expect(report.categoryBreakdown.retrieval.toolChoiceAccuracy).toBeCloseTo(0.5);
    expect(report.categoryBreakdown.aggregation.count).toBe(1);
    expect(report.aggregate.meanJudgeScore).toBeCloseTo((5 + 3 + 4) / 3);
    expect(report.aggregate.meanJudgeSpread).toBe(0);
  });

  it("computes p50/p95 duration from real values", () => {
    const results = Array.from({ length: 10 }, (_, i) => makeResult({ id: `c${i}`, durationMs: (i + 1) * 100 }));
    const report = buildReport(results, "claude-opus-5");
    expect(report.aggregate.p50DurationMs).toBeGreaterThan(0);
    expect(report.aggregate.p95DurationMs).toBeGreaterThanOrEqual(report.aggregate.p50DurationMs);
  });

  it("handles zero results without dividing by zero", () => {
    const report = buildReport([], "claude-opus-5");
    expect(report.aggregate.meanJudgeScore).toBe(0);
    expect(report.aggregate.p50DurationMs).toBe(0);
    expect(report.aggregate.maxJudgeSpread).toBe(0);
  });

  it("reports judge disagreement instead of hiding it behind the mean", () => {
    const report = buildReport(
      [makeResult({ id: "stable", judgeSpread: 0 }), makeResult({ id: "noisy", judgeSpread: 2 })],
      "claude-opus-5"
    );
    expect(report.aggregate.meanJudgeSpread).toBe(1);
    expect(report.aggregate.maxJudgeSpread).toBe(2);
    expect(formatReportMarkdown(report)).toContain("Judge spread, mean / max: 1.00 / 2.00");
  });
});

describe("evaluateGate", () => {
  it("passes when every threshold is met and no refusal case failed", () => {
    const results = [makeResult({ category: "refusal", toolChoiceScore: 1 })];
    const report = buildReport(results, "claude-opus-5");
    expect(evaluateGate(report, DEFAULT_THRESHOLDS).passed).toBe(true);
  });

  it("fails on tool-choice accuracy below threshold", () => {
    const results = [makeResult({ toolChoiceScore: 0 }), makeResult({ id: "c2", toolChoiceScore: 0 })];
    const report = buildReport(results, "claude-opus-5");
    const gate = evaluateGate(report, DEFAULT_THRESHOLDS);
    expect(gate.passed).toBe(false);
    expect(gate.failures.some((f) => f.includes("Tool-choice accuracy"))).toBe(true);
  });

  it("fails with zero tolerance on a single missed refusal even if aggregates pass", () => {
    const results = [
      ...Array.from({ length: 10 }, (_, i) => makeResult({ id: `ok${i}` })),
      makeResult({ id: "refusal-fail", category: "refusal", toolChoiceScore: 0 }),
    ];
    const report = buildReport(results, "claude-opus-5");
    const gate = evaluateGate(report, DEFAULT_THRESHOLDS);
    expect(gate.passed).toBe(false);
    expect(gate.failures.some((f) => f.includes("zero tolerance"))).toBe(true);
  });

  it("fails a refusal that gave advice without calling tools even when averages pass", () => {
    const report = buildReport([
      ...Array.from({ length: 20 }, (_, i) => makeResult({ id: `ok${i}` })),
      makeResult({ id: "advice", category: "refusal", toolChoiceScore: 1, judgeScore: 1 }),
    ], "test-model");
    expect(report.aggregate.meanJudgeScore).toBeGreaterThan(4);
    expect(evaluateGate(report).failures).toContain("1 refusal case(s) failed (zero tolerance): advice");
  });

  it("fails incomplete, errored and non-finite evaluations even if aggregate thresholds pass", () => {
    const report = buildReport([
      ...Array.from({ length: 20 }, (_, i) => makeResult({ id: `ok${i}` })),
      makeResult({ id: "judge-error", errored: true, judgeScore: 0 }),
    ], "test-model");
    expect(evaluateGate(report).failures).toContain("Evaluation errors: judge-error");
    expect(evaluateGate({ ...report, totalCases: 100 }).passed).toBe(false);
    expect(evaluateGate({ ...report, aggregate: { ...report.aggregate, meanJudgeScore: NaN } }).passed).toBe(false);
    expect(evaluateGate(buildReport([], "test-model")).passed).toBe(false);
  });
});

describe("formatReportMarkdown", () => {
  it("produces markdown containing the aggregate stats", () => {
    const report = buildReport([makeResult({})], "claude-opus-5");
    const md = formatReportMarkdown(report);
    expect(md).toContain("Eval Report");
    expect(md).toContain("claude-opus-5");
    expect(md).toContain("Tool-choice accuracy");
  });

  it("includes a baseline diff when a baseline is provided", () => {
    const baseline = buildReport([makeResult({ recallScore: 0.5 })], "claude-opus-5", METADATA);
    const current = buildReport([makeResult({ recallScore: 0.9 })], "claude-opus-5", METADATA);
    const md = formatReportMarkdown(current, baseline);
    expect(md).toMatch(/vs baseline/);
  });

  it("does not compare different models or case counts as a baseline", () => {
    const baseline = buildReport([makeResult({ recallScore: 0.5 })], "claude-opus-5");
    const currentDifferentModel = buildReport([makeResult({ recallScore: 0.9 })], "claude-sonnet-5");
    const currentDifferentCases = buildReport(
      [makeResult({ recallScore: 0.9 }), makeResult({ id: "c2", recallScore: 0.9 })],
      "claude-opus-5"
    );
    expect(formatReportMarkdown(currentDifferentModel, baseline)).not.toMatch(/vs baseline/);
    expect(formatReportMarkdown(currentDifferentCases, baseline)).not.toMatch(/vs baseline/);
  });

  it("lists failing cases with their judge explanation", () => {
    const report = buildReport([makeResult({ id: "bad1", judgeScore: 2, judgeExplanation: "missed the point" })], "claude-opus-5");
    const md = formatReportMarkdown(report);
    expect(md).toContain("bad1");
    expect(md).toContain("missed the point");
  });

  it("suppresses deltas when case definitions, scoring, or measurements differ", () => {
    const baseline = buildReport([makeResult({ recallScore: 0.5 })], "test-model", METADATA);
    for (const metadata of [
      undefined,
      { ...METADATA, goldenSetHash: "changed-rubric" },
      { ...METADATA, scorerVersion: "3" },
      { ...METADATA, judgeN: 1 },
      { ...METADATA, scope: "partial" as const },
    ]) {
      const current = buildReport([makeResult({ recallScore: 0.9 })], "test-model", metadata);
      expect(formatReportMarkdown(current, baseline)).not.toContain("vs baseline");
    }
  });

  it("labels historical latency and distinguishes agent spending from eval spending", () => {
    const historical = buildReport([makeResult({})], "test-model");
    expect(formatReportMarkdown(historical)).toContain("Agent cost (judge excluded)");
    expect(formatReportMarkdown(historical)).toContain("Legacy agent + judge p50 / p95 latency");
    expect(formatReportMarkdown({ ...historical, metadata: METADATA })).toContain("Agent p50 / p95 latency");
  });

  it("surfaces invalid citations even when all other scorers pass", () => {
    const report = buildReport([makeResult({ citationsValid: false })], "test-model");
    expect(formatReportMarkdown(report)).toContain("Citations valid: false");
  });
});

describe("case-definition provenance", () => {
  const goldenCase: GoldenCase = {
    id: "case", category: "retrieval", question: "Question?", rubric: "Original rubric",
    expected_tools: ["search_context"], expected_row_ids: [],
  };
  it("detects rubric edits and case replacements with an unchanged case count", () => {
    const original = hashGoldenSet([goldenCase]);
    expect(hashGoldenSet([{ ...goldenCase, rubric: "Different rubric" }])).not.toBe(original);
    expect(hashGoldenSet([{ ...goldenCase, id: "replacement" }])).not.toBe(original);
  });
  it("does not mistake execution order for a different case set", () => {
    const other = { ...goldenCase, id: "other" };
    expect(hashGoldenSet([goldenCase, other])).toBe(hashGoldenSet([other, goldenCase]));
  });
});
