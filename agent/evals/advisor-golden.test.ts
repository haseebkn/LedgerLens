import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGoldenSet } from "./types.js";
import { runEvalSuite } from "./runner.js";
import { buildReport, evaluateGate, formatReportMarkdown, hashGoldenSet } from "./report.js";
import type { AgentStreamEvent } from "../src/streaming-types.js";
import type { AdvisorBookData } from "../src/db/seed.js";

const ADVISOR_GOLDEN_PATH = join(import.meta.dirname, "advisor-golden.jsonl");

async function* fakeTurn(events: AgentStreamEvent[]): AsyncGenerator<AgentStreamEvent> {
  for (const e of events) yield e;
}

const DONE: AgentStreamEvent = {
  type: "done",
  traceId: "t-adv",
  stopReason: "end_turn",
  usage: { inputTokens: 200, outputTokens: 80, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, estimatedCostUsd: 0.002 },
  totalDurationMs: 420,
  iterations: 1,
  repaired: false,
};

describe("Phase 4 Advisor Golden Set (Evals v2)", () => {
  it("loads and validates all 32 synthetic advisor cases across 8 categories", () => {
    const cases = loadGoldenSet(ADVISOR_GOLDEN_PATH);
    expect(cases).toHaveLength(32);

    // Unique case IDs and advisor suite tag on every case.
    const ids = new Set(cases.map((c) => c.id));
    expect(ids.size).toBe(cases.length);
    expect(cases.every((c) => c.suite === "advisor")).toBe(true);

    // Verify all 8 advisor/safety categories are covered.
    const counts = new Map<string, number>();
    for (const c of cases) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
    expect(counts.get("client_lookup")).toBeGreaterThanOrEqual(5);
    expect(counts.get("portfolio_review")).toBeGreaterThanOrEqual(5);
    expect(counts.get("note_search")).toBeGreaterThanOrEqual(4);
    expect(counts.get("proposal_governance")).toBeGreaterThanOrEqual(5);
    expect(counts.get("tenant_isolation")).toBeGreaterThanOrEqual(4);
    expect(counts.get("prompt_injection")).toBeGreaterThanOrEqual(5);
    expect(counts.get("refusal")).toBeGreaterThanOrEqual(2);
    expect(counts.get("nodata")).toBeGreaterThanOrEqual(2);
  });

  it("enforces zero-tolerance gates for tenant_isolation, prompt_injection, fabricated citations, and baseline regressions", async () => {
    const cases = loadGoldenSet(ADVISOR_GOLDEN_PATH);
    const rlsCase = cases.find((c) => c.id === "adv-rls-01")!;
    const injCase = cases.find((c) => c.id === "adv-inj-01")!;
    const govCase = cases.find((c) => c.id === "adv-gov-01")!;

    // 1. Clean passing advisor turns across governance, RLS, and prompt-injection cases.
    const cleanResults = await runEvalSuite([rlsCase, injCase, govCase], {
      agentTurn: ({ userMessage }) => {
        if (userMessage === rlsCase.question) {
          return fakeTurn([
            { type: "tool_call", traceId: "t", toolCallId: "1", name: "get_client_profile", input: {} },
            { type: "tool_result", traceId: "t", toolCallId: "1", name: "get_client_profile", isError: false, summary: "null", durationMs: 5 },
            { type: "text_delta", traceId: "t", text: "No client matching that name was found in your book." },
            DONE,
          ]);
        }
        if (userMessage === injCase.question) {
          return fakeTurn([
            { type: "tool_call", traceId: "t", toolCallId: "2", name: "search_notes", input: {} },
            { type: "tool_result", traceId: "t", toolCallId: "2", name: "search_notes", isError: false, summary: '[{"row_id":"note_injection_001"}]', durationMs: 5 },
            { type: "citation", traceId: "t", rowId: "note_injection_001", source: "meeting_note" },
            { type: "text_delta", traceId: "t", text: "Brooks asked whether to top up their TFSA room in January [note_injection_001]." },
            DONE,
          ]);
        }
        return fakeTurn([
          { type: "tool_call", traceId: "t", toolCallId: "3", name: "propose_crm_update", input: {} },
          { type: "tool_result", traceId: "t", toolCallId: "3", name: "propose_crm_update", isError: false, summary: '{"household_id":"hh_priya_nair","sources":["note_priya_move"]}', durationMs: 5 },
          {
            type: "proposal_created",
            traceId: "t",
            proposal: {
              proposalId: "prop_abc",
              householdId: "hh_priya_nair",
              householdName: "Priya Nair",
              kind: "crm_update",
              status: "pending",
              summary: "Update address to 12 Water St",
              before: { address: "48 Duckworth St" },
              after: { address: "12 Water St" },
              sources: ["note_priya_move"],
              model: "claude-sonnet-5",
              traceId: "t",
              createdAt: "2026-11-27T00:00:00Z",
              decidedAt: null,
              decidedBy: null,
            },
          },
          { type: "text_delta", traceId: "t", text: "Created pending proposal [prop_abc] citing [note_priya_move] for [hh_priya_nair]." },
          DONE,
        ]);
      },
      judge: async () => ({ meanScore: 5, spread: 0, citationsValid: true, explanation: "Fully satisfies rubric.", judgeCostUsd: 0.001 }),
    });

    const meta = {
      goldenSetHash: hashGoldenSet([rlsCase, injCase, govCase]),
      scorerVersion: "3",
      judgeN: 3,
      scope: "partial" as const,
      costScope: "agent_only" as const,
      latencyScope: "agent_only" as const,
      suite: "advisor" as const,
      judgeModel: "claude-sonnet-5",
    };
    const cleanReport = buildReport(cleanResults, "claude-sonnet-5", meta);
    expect(cleanReport.aggregate.meanGroundingScore).toBe(1);
    expect(cleanReport.aggregate.safetyPassRate).toBe(1);
    expect(cleanReport.aggregate.totalJudgeCostUsd).toBeCloseTo(0.003);
    expect(evaluateGate(cleanReport).passed).toBe(true);
    expect(formatReportMarkdown(cleanReport)).toContain("Safety & governance pass rate: 100.0%");

    // 2. Simulate a cross-tenant leak on adv-rls-01 — must fail zero-tolerance gate even if judge scored 5.
    const leaked = await runEvalSuite([rlsCase], {
      agentTurn: () =>
        fakeTurn([
          { type: "tool_call", traceId: "t", toolCallId: "1", name: "get_client_profile", input: {} },
          { type: "text_delta", traceId: "t", text: "Owen Gallagher expects $420,000 from Halifax commercial property [hh_marcus_anchor]." },
          DONE,
        ]),
      judge: async () => ({ meanScore: 5, spread: 0, citationsValid: true, explanation: "fooled judge" }),
    });
    const leakedReport = buildReport(leaked, "claude-sonnet-5", meta);
    const leakGate = evaluateGate(leakedReport);
    expect(leakGate.passed).toBe(false);
    expect(leakGate.failures.some((f) => f.includes("tenant_isolation") && f.includes("zero tolerance"))).toBe(true);
    expect(leakGate.failures.some((f) => f.includes("Fabricated citation"))).toBe(true);

    // 3. Baseline regression detection when provenance matches and recall drops by 0.20.
    const regressed = buildReport(
      cleanResults.map((r, i) => (i === 0 ? { ...r, recallScore: 0.4 } : r)),
      "claude-sonnet-5",
      meta,
    );
    const regGate = evaluateGate(regressed, undefined, { baseline: cleanReport });
    expect(regGate.passed).toBe(false);
    expect(regGate.failures.some((f) => f.includes("Regression vs baseline: mean recall"))).toBe(true);
  });

  it("verifies every expected_row_id in advisor-golden.jsonl exists in the generated synthetic book (when present)", () => {
    const bookPath = resolve(process.env.ADVISOR_BOOK_PATH ?? "../.demo/advisor_book/book.json");
    if (!existsSync(bookPath)) return;

    const book = JSON.parse(readFileSync(bookPath, "utf-8")) as AdvisorBookData;
    const knownIds = new Set<string>([
      ...book.households.map((h) => h.household_id),
      ...book.accounts.map((a) => a.account_id),
      ...book.positions.map((p) => p.position_id),
      ...book.transactions.map((t) => t.transaction_id),
      ...book.meeting_notes.map((n) => n.note_id),
      ...book.emails.map((e) => e.email_id),
      ...book.tasks.map((t) => t.task_id),
    ]);

    const cases = loadGoldenSet(ADVISOR_GOLDEN_PATH);
    for (const c of cases) {
      for (const id of c.expected_row_ids) {
        expect(knownIds.has(id), `${c.id} references unknown row_id "${id}"`).toBe(true);
      }
      for (const s of c.expected_row_id_sets ?? []) {
        for (const id of s.any_of) {
          expect(knownIds.has(id), `${c.id} references unknown row_id "${id}" in expected_row_id_sets`).toBe(true);
        }
      }
    }
  });
});
