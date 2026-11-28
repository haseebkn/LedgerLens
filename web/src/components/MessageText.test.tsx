import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageText } from "./MessageText.js";

afterEach(cleanup);

describe("MessageText", () => {
  it("renders agent markdown tables as semantic tables", () => {
    render(
      <MessageText text={"| Category | Total |\n|---|---:|\n| Food and Drink | **$4,422.92** |"} />
    );

    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Category" })).toBeInTheDocument();
    expect(within(table).getByText("$4,422.92").tagName).toBe("STRONG");
  });

  it("renders citations inside table cells as source chips", () => {
    render(
      <MessageText text={"| Merchant | Amount |\n|---|---:|\n| Starbucks [plaid_a] | $4.33 |"} />
    );

    expect(screen.getByTitle("plaid_a")).toBeInTheDocument();
  });
});

describe("unverified figures", () => {
  it("marks only the paragraph that holds a flagged figure", () => {
    render(
      <MessageText
        text={"Food was $120.50 [plaid_a].\n\nRent was $900."}
        warnings={[{ figure: "$900", kind: "amount", sentence: "Rent was $900.", reason: "uncited", citedIds: [] }]}
      />,
    );
    const markers = screen.getAllByText("Unverified");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.closest("p")).toHaveTextContent("Rent was $900.");
    expect(markers[0]).toHaveAttribute("title", "$900: no source cited");
  });
});
