import { describe, expect, it } from "vitest";
import { checkNumericGrounding, extractEvidence, splitClaims } from "./grounding.js";

const spendResult = JSON.stringify({
  result_id: "computed_spend_1",
  grand_total: 1234.56,
  breakdown: [
    { group: "Food and Drink", total: 120.5, count: 3, sample_row_ids: ["plaid_a", "plaid_b"] },
    { group: "Travel", total: 1114.06, count: 1, sample_row_ids: ["plaid_c"] },
  ],
});
const searchResult = JSON.stringify([
  { row_id: "plaid_d", text: "Coffee at Bean Co for $4.50 on 2026-03-02", source: "plaid" },
]);

function evidence() {
  return extractEvidence(searchResult, extractEvidence(spendResult));
}

describe("extractEvidence", () => {
  it("lets a result_id vouch for every number in its result", () => {
    expect([...evidence().get("computed_spend_1")!]).toEqual(expect.arrayContaining([1234.56, 120.5, 1114.06]));
  });

  it("scopes a sample row id to the group it was sampled from", () => {
    const e = evidence();
    expect(e.get("plaid_a")!.has(120.5)).toBe(true);
    expect(e.get("plaid_a")!.has(1114.06)).toBe(false);
  });

  it("reads amounts written inside text fields", () => {
    expect(evidence().get("plaid_d")!.has(4.5)).toBe(true);
  });

  it("ignores non-JSON tool text, such as an id echoed in a 'no results' message", () => {
    expect(extractEvidence('No results found for "plaid_x".').size).toBe(0);
  });
});

describe("checkNumericGrounding", () => {
  it("passes figures that appear in the cited evidence", () => {
    const text = "You spent $1,234.56 in total [computed_spend_1]. Food was $120.50 [plaid_a]. Coffee cost $4.50 [plaid_d].";
    expect(checkNumericGrounding(text, evidence())).toEqual([]);
  });

  it("allows whole-dollar rounding only when the answer omits cents", () => {
    expect(checkNumericGrounding("About $1,235 overall [computed_spend_1].", evidence())).toEqual([]);
    expect(checkNumericGrounding("Exactly $1,235.00 overall [computed_spend_1].", evidence())).toHaveLength(1);
  });

  it("flags a dollar figure with no citation in its sentence", () => {
    const [warning] = checkNumericGrounding("You spent $500 on rent. Food was $120.50 [plaid_a].", evidence());
    expect(warning).toMatchObject({ figure: "$500", reason: "uncited", sentence: "You spent $500 on rent." });
  });

  it("flags a figure its citation does not contain", () => {
    const [warning] = checkNumericGrounding("Travel was $1,114.06 [plaid_a].", evidence());
    expect(warning).toMatchObject({ figure: "$1,114.06", reason: "not_in_source", citedIds: ["plaid_a"] });
  });

  it("flags a total the model computed itself from two cited rows", () => {
    expect(checkNumericGrounding("Together that is $125.00 [plaid_a] [plaid_d].", evidence())).toMatchObject([
      { reason: "not_in_source" },
    ]);
  });

  it("checks each table row against the citations in that row", () => {
    const table = "| Category | Total |\n|---|---|\n| Food | $120.50 [plaid_a] |\n| Travel | $9.99 [plaid_c] |";
    expect(checkNumericGrounding(table, evidence())).toMatchObject([{ figure: "$9.99" }]);
  });

  it("ignores answers with no dollar figures", () => {
    expect(checkNumericGrounding("I can't give investment advice.", evidence())).toEqual([]);
  });
});

describe("splitClaims", () => {
  it("keeps a trailing citation with its sentence and does not split on decimals", () => {
    expect(splitClaims("It was $4.50. [plaid_d] Next sentence.")).toEqual(["It was $4.50. [plaid_d] Next sentence."]);
  });
});
