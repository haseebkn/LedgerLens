import { describe, expect, it } from "vitest";
import { parseEvalArgs } from "./cli.js";

describe("eval CLI validation", () => {
  it("parses full, advisor, category-filtered, and focused runs", () => {
    expect(parseEvalArgs([])).toMatchObject({ suite: "personal", write: true, gate: false });
    expect(parseEvalArgs(["--cases", "retrieval-05, aggregation-02", "--judge-n", "2", "--no-write", "--gate"])).toEqual({
      suite: "personal",
      caseIds: ["retrieval-05", "aggregation-02"],
      categories: undefined,
      subset: undefined,
      judgeN: 2,
      write: false,
      gate: true,
    });
    expect(
      parseEvalArgs(["--suite", "advisor", "--category", "tenant_isolation, prompt_injection", "--gate"]),
    ).toEqual({
      suite: "advisor",
      caseIds: undefined,
      categories: ["tenant_isolation", "prompt_injection"],
      subset: undefined,
      judgeN: undefined,
      write: true,
      gate: true,
    });
  });
  it.each([
    ["--cases"], ["--cases", "--no-write"], ["--cases", ","], ["--cases", "a,a"],
    ["--suite"], ["--suite", "invalid"],
    ["--category"], ["--category", ","], ["--category", "refusal,refusal"],
    ["--subset", "0"], ["--judge-n", "NaN"], ["--judge-n", "1.5"],
    ["--subset", "1", "--cases", "a"], ["--gate", "--gate"], ["--typo"],
  ])("rejects malformed arguments: %j", (...argv) => {
    expect(() => parseEvalArgs(argv)).toThrow();
  });
});
