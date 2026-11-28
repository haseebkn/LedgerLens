import { describe, expect, it } from "vitest";
import { scoreGrounding } from "./grounding.js";

describe("scoreGrounding (Phase 4 deterministic grounding scorer)", () => {
  it("scores 1.0 when all cited IDs were observed and there are no citation warnings", () => {
    const res = scoreGrounding({
      answerText: "Priya Nair moved to 12 Water St [note_priya_move] and has 3 accounts [hh_priya_nair].",
      seenRowIds: ["note_priya_move", "hh_priya_nair"],
      citationWarningCount: 0,
    });
    expect(res).toEqual({
      groundingScore: 1,
      citationPrecision: 1,
      citationWarningCount: 0,
      fabricatedCitations: [],
    });
  });

  it("scores 0 immediately when the answer fabricates a citation ID not seen in tool results", () => {
    const res = scoreGrounding({
      answerText: "Priya's balance is $500,000 [acct_fake_999] per [hh_priya_nair].",
      seenRowIds: ["hh_priya_nair"],
      citationWarningCount: 0,
    });
    expect(res.groundingScore).toBe(0);
    expect(res.fabricatedCitations).toEqual(["acct_fake_999"]);
    expect(res.citationPrecision).toBe(0.5);
  });

  it("penalizes grounding score for each unverified-figure citation warning", () => {
    const res = scoreGrounding({
      answerText: "Total AUM is $410,000 [computed_review_abc].",
      seenRowIds: ["computed_review_abc"],
      citationWarningCount: 2,
    });
    expect(res.groundingScore).toBe(0.5);
    expect(res.citationWarningCount).toBe(2);
    expect(res.fabricatedCitations).toEqual([]);
  });

  it("returns 1.0 on refusal/no-data answers with zero citations and zero warnings", () => {
    const res = scoreGrounding({
      answerText: "I cannot provide investment advice on whether to sell MSFT.",
      seenRowIds: [],
      citationWarningCount: 0,
    });
    expect(res.groundingScore).toBe(1);
    expect(res.citationPrecision).toBe(1);
  });
});
