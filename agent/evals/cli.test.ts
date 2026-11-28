import { describe, expect, it } from "vitest";
import { parseEvalArgs } from "./cli.js";

describe("eval CLI validation", () => {
  it("parses full and focused runs", () => {
    expect(parseEvalArgs([])).toMatchObject({ write: true, gate: false });
    expect(parseEvalArgs(["--cases", "retrieval-05, aggregation-02", "--judge-n", "2", "--no-write", "--gate"])).toEqual({
      caseIds: ["retrieval-05", "aggregation-02"], subset: undefined, judgeN: 2, write: false, gate: true,
    });
  });
  it.each([
    ["--cases"], ["--cases", "--no-write"], ["--cases", ","], ["--cases", "a,a"],
    ["--subset", "0"], ["--judge-n", "NaN"], ["--judge-n", "1.5"],
    ["--subset", "1", "--cases", "a"], ["--gate", "--gate"], ["--typo"],
  ])("rejects malformed arguments: %j", (...argv) => {
    expect(() => parseEvalArgs(argv)).toThrow();
  });
});
