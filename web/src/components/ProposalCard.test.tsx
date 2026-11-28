import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProposalPayload } from "financial-context-agent/streaming-types";
import { ProposalCard } from "./ProposalCard.js";

const SAMPLE_PROPOSAL: ProposalPayload = {
  proposalId: "prop_abc123",
  householdId: "hh_priya_nair",
  householdName: "Priya Nair",
  kind: "crm_update",
  status: "pending",
  summary: "Update Priya Nair's mailing address from recent call",
  before: { address: "48 Duckworth St, St. John's, NL A1C 1E6" },
  after: { address: "12 Water St, St. John's, NL A1C 1A1" },
  sources: ["note_priya_move"],
  model: "claude-sonnet-5",
  traceId: "trace_1",
  createdAt: "2026-11-27T20:00:00Z",
  decidedAt: null,
  decidedBy: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProposalCard", () => {
  it("shows old -> new diff, source chips, and calls approve endpoint", async () => {
    const approved: ProposalPayload = { ...SAMPLE_PROPOSAL, status: "approved", decidedBy: "adv_sarah" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ proposal: approved }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onUpdated = vi.fn();

    render(<ProposalCard proposal={SAMPLE_PROPOSAL} onUpdated={onUpdated} />);

    expect(screen.getByText(/48 Duckworth St/)).toBeInTheDocument();
    expect(screen.getByText(/12 Water St/)).toBeInTheDocument();
    expect(screen.getByText("Meeting Note")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledWith(approved));
    expect(fetchMock).toHaveBeenCalledWith("/api/proposals/prop_abc123/approve", expect.objectContaining({ method: "POST" }));
  });

  it("allows inline editing before Save & Approve", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.after).toEqual({ address: "12 Water St, Unit 2" });
      return new Response(JSON.stringify({ proposal: { ...SAMPLE_PROPOSAL, status: "approved", after: body.after } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onUpdated = vi.fn();

    render(<ProposalCard proposal={SAMPLE_PROPOSAL} onUpdated={onUpdated} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByDisplayValue(/12 Water St/), { target: { value: "12 Water St, Unit 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & Approve" }));

    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled());
  });

  it("calls reject endpoint when Reject is clicked", async () => {
    const rejected: ProposalPayload = { ...SAMPLE_PROPOSAL, status: "rejected" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ proposal: rejected }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onUpdated = vi.fn();

    render(<ProposalCard proposal={SAMPLE_PROPOSAL} onUpdated={onUpdated} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledWith(rejected));
    expect(fetchMock).toHaveBeenCalledWith("/api/proposals/prop_abc123/reject", expect.objectContaining({ method: "POST" }));
  });
});
