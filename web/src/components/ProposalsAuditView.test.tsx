import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProposalsAuditView } from "./ProposalsAuditView.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProposalsAuditView", () => {
  it("renders proposals and append-only audit entries when advisor mode is active", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path === "/api/proposals") {
          return new Response(
            JSON.stringify({
              advisorMode: true,
              proposals: [
                {
                  proposalId: "prop_1",
                  householdId: "hh_priya_nair",
                  householdName: "Priya Nair",
                  kind: "crm_update",
                  status: "pending",
                  summary: "Update address",
                  before: { address: "48 Duckworth St" },
                  after: { address: "12 Water St" },
                  sources: ["note_priya_move"],
                  model: "claude-sonnet-5",
                  traceId: "t1",
                  createdAt: "2026-11-27T20:00:00Z",
                  decidedAt: null,
                  decidedBy: null,
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            advisorMode: true,
            entries: [
              {
                auditId: "audit_1",
                proposalId: "prop_0",
                action: "crm_update_approved",
                actorId: "adv_sarah",
                targetTable: "households",
                targetId: "hh_priya_nair",
                diff: { address: { old: "old", new: "new" } },
                sources: ["note_priya_move"],
                model: "claude-sonnet-5",
                traceId: "trace_abcdef12",
                createdAt: "2026-11-27T19:00:00Z",
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    render(<ProposalsAuditView />);
    expect(await screen.findByText("Priya Nair")).toBeInTheDocument();
    expect(screen.getByText("crm_update_approved")).toBeInTheDocument();
    expect(screen.getByText("households:hh_priya_nair")).toBeInTheDocument();
  });

  it("shows a clear message when Postgres advisor mode is not configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        new Response(
          JSON.stringify(String(input) === "/api/proposals" ? { advisorMode: false, proposals: [] } : { advisorMode: false, entries: [] }),
          { status: 200 },
        ),
      ),
    );

    render(<ProposalsAuditView />);
    expect(await screen.findByText(/Advisor mode is not enabled/)).toBeInTheDocument();
  });
});
