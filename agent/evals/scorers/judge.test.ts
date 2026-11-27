import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadGoldenSet } from "../types.js";
import { JUDGE_SYSTEM_PROMPT, judgeWithSpread, parseJudgment } from "./judge.js";

describe("judge rubric discipline", () => {
  it("does not reward aggregation-05 for asking a clarifying question instead of reporting totals", () => {
    const goldenCase = loadGoldenSet(join(import.meta.dirname, "..", "golden.jsonl")).find(
      (candidate) => candidate.id === "aggregation-05"
    );

    expect(goldenCase?.rubric).toContain("A clarifying question without the totals fails");
    expect(JUDGE_SYSTEM_PROMPT).toContain("a clarifying question");
    expect(JUDGE_SYSTEM_PROMPT).toContain("provides none of the required result should score 1");
    expect(JUDGE_SYSTEM_PROMPT).toContain("rubric is the sole contract");
  });
});

describe("structured judgment validation", () => {
  it("accepts a score in range and rejects malformed values before report aggregation", () => {
    const valid = { score: 4, citations_valid: true, explanation: "Meets the rubric." };
    expect(parseJudgment(valid)).toEqual({ score: 4, citationsValid: true, explanation: "Meets the rubric." });
    for (const score of [undefined, "5", NaN, 0, 6, 4.5]) {
      expect(() => parseJudgment({ ...valid, score })).toThrow();
    }
    expect(() => parseJudgment({ ...valid, citations_valid: "true" })).toThrow();
    expect(() => parseJudgment({ ...valid, explanation: "" })).toThrow();
  });

  it("rejects zero samples without calling the provider", async () => {
    const goldenCase = loadGoldenSet(join(import.meta.dirname, "..", "golden.jsonl"))[0]!;
    await expect(judgeWithSpread(goldenCase, "answer", 0)).rejects.toThrow("positive integer");
  });
});
