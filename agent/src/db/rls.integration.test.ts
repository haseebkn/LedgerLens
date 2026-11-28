import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { closePool, createPool, withTenantContext } from "./client.js";
import { runMigrations } from "./migrate.js";
import { seedAdvisorBook, type AdvisorBookData } from "./seed.js";
import { searchAdvisorNotes } from "./advisor-repo.js";
import {
  findClients,
  getAdvisorRowById,
  getClientActivity,
  getClientProfile,
  preparePortfolioReview,
  queryAdvisorWarehouse,
} from "../advisor/queries.js";
import {
  createProposal,
  decideProposal,
  listAuditLog,
  listProposals,
  ProposalConflictError,
} from "../advisor/proposals.js";

/**
 * Real Postgres + pgvector + Row-Level Security integration suite.
 * Runs automatically in CI (postgres-rls job) and whenever DATABASE_URL and
 * ADVISOR_BOOK_PATH are provided locally.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim();
const BOOK_PATH = resolve(process.env.ADVISOR_BOOK_PATH ?? "../.demo/advisor_book/book.json");
const CAN_RUN = Boolean(DATABASE_URL && existsSync(BOOK_PATH));

const FIRM = "firm_atlantic_wealth";
const SARAH = { firmId: FIRM, advisorId: "adv_sarah" } as const;
const MARCUS = { firmId: FIRM, advisorId: "adv_marcus" } as const;
const APP_ROLE = process.env.DB_APP_ROLE ?? "ledgerlens_app";
const RO_ROLE = process.env.DB_RO_ROLE ?? "ledgerlens_ro";

describe.skipIf(!CAN_RUN)("Postgres + pgvector + Row-Level Security (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await runMigrations(pool);
    // Re-running migrations must be an idempotent no-op.
    expect(await runMigrations(pool)).toEqual([]);

    const book = JSON.parse(readFileSync(BOOK_PATH, "utf-8")) as AdvisorBookData;
    const counts = await seedAdvisorBook(pool, book);
    expect(counts.households).toBe(60);
    expect(counts.meeting_notes).toBe(150);
    expect(counts.emails).toBe(300);
  }, 60_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
  });

  it("enforces Row-Level Security: advisor A never sees advisor B's households or data", async () => {
    const sarahRows = await withTenantContext(
      pool,
      SARAH,
      (c) => c.query<{ household_id: string; name: string }>("SELECT household_id, name FROM households"),
      { role: APP_ROLE },
    );
    expect(sarahRows.rows).toHaveLength(36);
    expect(sarahRows.rows.some((r) => r.household_id === "hh_priya_nair")).toBe(true);
    expect(sarahRows.rows.some((r) => r.household_id === "hh_marcus_anchor")).toBe(false);

    // Direct lookup of Marcus's client by ID returns 0 rows under Sarah's RLS context.
    const crossLookup = await withTenantContext(
      pool,
      SARAH,
      (c) => c.query("SELECT * FROM households WHERE household_id = $1", ["hh_marcus_anchor"]),
      { role: APP_ROLE },
    );
    expect(crossLookup.rows).toHaveLength(0);

    const marcusRows = await withTenantContext(
      pool,
      MARCUS,
      (c) => c.query<{ household_id: string }>("SELECT household_id FROM households"),
      { role: APP_ROLE },
    );
    expect(marcusRows.rows).toHaveLength(24);
    expect(marcusRows.rows.some((r) => r.household_id === "hh_marcus_anchor")).toBe(true);
    expect(marcusRows.rows.some((r) => r.household_id === "hh_priya_nair")).toBe(false);
  });

  it("blocks cross-tenant writes via RLS WITH CHECK policy", async () => {
    await expect(
      withTenantContext(
        pool,
        SARAH,
        (c) =>
          c.query(
            `INSERT INTO tasks (task_id, firm_id, advisor_id, household_id, title)
             VALUES ('task_illegal', $1, 'adv_marcus', 'hh_marcus_anchor', 'Should fail')`,
            [FIRM],
          ),
        { role: APP_ROLE },
      ),
    ).rejects.toThrow(/row-level security policy/);
  });

  it("enforces read-only allowlisted views and RLS for the SQL tool role (ledgerlens_ro)", async () => {
    const viewRes = await withTenantContext(
      pool,
      SARAH,
      (c) => c.query("SELECT household_id FROM v_households"),
      { readOnly: true, role: RO_ROLE, statementTimeoutMs: 5000 },
    );
    expect(viewRes.rows).toHaveLength(36);

    const notesRes = await withTenantContext(
      pool,
      SARAH,
      (c) => c.query("SELECT note_id FROM v_meeting_notes LIMIT 5"),
      { readOnly: true, role: RO_ROLE, statementTimeoutMs: 5000 },
    );
    expect(notesRes.rows.length).toBeGreaterThan(0);

    // Non-allowlisted tables and vector columns must be inaccessible to ledgerlens_ro.
    await expect(
      withTenantContext(
        pool,
        SARAH,
        (c) => c.query("SELECT embedding FROM meeting_notes LIMIT 1"),
        { readOnly: true, role: RO_ROLE },
      ),
    ).rejects.toThrow(/permission denied/);

    await expect(
      withTenantContext(
        pool,
        SARAH,
        (c) => c.query("SELECT * FROM advisors LIMIT 1"),
        { readOnly: true, role: RO_ROLE },
      ),
    ).rejects.toThrow(/permission denied/);

    // Writes must be refused by both the read-only transaction and role grants.
    await expect(
      withTenantContext(
        pool,
        SARAH,
        (c) => c.query("DELETE FROM households WHERE household_id = 'hh_priya_nair'"),
        { readOnly: true, role: RO_ROLE },
      ),
    ).rejects.toThrow(/read-only|permission denied/);
  });

  it("enforces append-only audit_log (allows INSERT, rejects UPDATE and DELETE)", async () => {
    const auditId = `audit_test_${Date.now()}`;
    await withTenantContext(
      pool,
      SARAH,
      (c) =>
        c.query(
          `INSERT INTO audit_log (audit_id, firm_id, advisor_id, action, actor_id, target_table, target_id, diff_json, sources, model, trace_id)
           VALUES ($1, $2, 'adv_sarah', 'crm_update', 'adv_sarah', 'households', 'hh_priya_nair', '{"address":{"old":"a","new":"b"}}'::jsonb, ARRAY['note_priya_move'], 'claude-sonnet-5', 'trace_1')`,
          [auditId, FIRM],
        ),
      { role: APP_ROLE },
    );

    await expect(
      withTenantContext(
        pool,
        SARAH,
        (c) => c.query("UPDATE audit_log SET action = 'tampered' WHERE audit_id = $1", [auditId]),
        { role: APP_ROLE },
      ),
    ).rejects.toThrow(/permission denied|append-only/);

    await expect(
      withTenantContext(
        pool,
        SARAH,
        (c) => c.query("DELETE FROM audit_log WHERE audit_id = $1", [auditId]),
        { role: APP_ROLE },
      ),
    ).rejects.toThrow(/permission denied|append-only/);
  });

  it("runs hybrid pgvector + tsvector search strictly within the signed-in advisor's book", async () => {
    const chenHits = await searchAdvisorNotes(pool, SARAH, { query: "daughter's university tuition", limit: 5 });
    expect(chenHits.length).toBeGreaterThan(0);
    expect(chenHits.some((h) => h.docId === "note_chen_tuition" || h.docId === "email_chen_tuition")).toBe(true);

    // Sarah searching for Marcus's confidential Halifax commercial property gets nothing.
    const leakedHits = await searchAdvisorNotes(pool, SARAH, { query: "Halifax commercial property $420,000", limit: 5 });
    expect(leakedHits.some((h) => h.householdId === "hh_marcus_anchor")).toBe(false);

    // Marcus finds his own client's note & email.
    const marcusHits = await searchAdvisorNotes(pool, MARCUS, { query: "Halifax commercial property", limit: 5 });
    expect(marcusHits.some((h) => h.docId === "note_marcus_owen" || h.docId === "email_marcus_owen")).toBe(true);
  });

  it("executes all Phase 3.2 advisor tools deterministically under RLS", async () => {
    // 1. find_clients: MSFT holders without a review in 6 months (Sarah only; never Marcus's Owen Gallagher)
    const msftOverdue = await findClients(pool, SARAH, { holding: "MSFT", lastReviewBefore: "2026-05-30" });
    expect(msftOverdue.result_id).toMatch(/^computed_clients_/);
    expect(msftOverdue.client_count).toBeGreaterThanOrEqual(5);
    expect(msftOverdue.clients.some((c) => c.household_id === "hh_priya_nair")).toBe(true);
    expect(msftOverdue.clients.some((c) => c.household_id === "hh_chen_family")).toBe(true);
    expect(msftOverdue.clients.some((c) => c.household_id === "hh_marcus_anchor")).toBe(false);

    // 2. get_client_profile: Priya across two custodians; Owen invisible to Sarah
    const priyaProfile = await getClientProfile(pool, SARAH, "Priya Nair");
    expect(priyaProfile?.household.multi_custodian).toBe(true);
    expect(priyaProfile?.household.custodians).toEqual(["Harbour Clearing", "Northstar Custody"]);
    expect(priyaProfile?.open_tasks.length).toBeGreaterThanOrEqual(2);
    expect(await getClientProfile(pool, SARAH, "Owen Gallagher")).toBeNull();

    // 3. get_client_activity: tested sign convention (Oct +$7,500; Sep +$4,000 - $1,000 = +$3,000)
    const oct = await getClientActivity(pool, SARAH, { clientId: "hh_priya_nair", start: "2026-10-01", end: "2026-11-01" });
    expect(oct?.totals.contributions).toBe(7500);
    expect(oct?.totals.withdrawals).toBe(0);
    expect(oct?.totals.net_flows).toBe(7500);

    const sep = await getClientActivity(pool, SARAH, { clientId: "hh_priya_nair", start: "2026-09-01", end: "2026-10-01" });
    expect(sep?.totals.contributions).toBe(4000);
    expect(sep?.totals.withdrawals).toBe(-1000);
    expect(sep?.totals.net_flows).toBe(3000);

    // 4. prepare_portfolio_review: deterministic allocation vs target, drift, AUM & YTD
    const review = await preparePortfolioReview(pool, SARAH, "Priya Nair");
    expect(review?.result_id).toMatch(/^computed_review_/);
    expect(review?.accounts).toHaveLength(3);
    expect(review?.total_aum).toBeGreaterThan(200_000);
    expect(
      review!.allocation.actual.equity_pct +
        review!.allocation.actual.fixed_income_pct +
        review!.allocation.actual.cash_pct,
    ).toBeCloseTo(100, 0);
    expect(review?.holdings.some((h) => h.symbol === "MSFT")).toBe(true);

    // 5. query_warehouse over allowlisted views + RLS-scoped source drawer row lookup
    const wh = await queryAdvisorWarehouse(pool, SARAH, "SELECT COUNT(*)::int AS n FROM v_households");
    expect(wh.rows[0]?.["n"]).toBe(36);
    expect((await getAdvisorRowById(pool, SARAH, "note_chen_tuition"))?.source).toBe("meeting_note");
    expect(await getAdvisorRowById(pool, SARAH, "hh_marcus_anchor")).toBeNull();
  });

  it("enforces approval-before-writes and records an append-only audit trail (Plan 3.3)", async () => {
    // Creating a CRM update proposal must NOT modify households until approved.
    const prop = await createProposal(pool, SARAH, {
      clientId: "hh_priya_nair",
      kind: "crm_update",
      summary: "Update Priya Nair's stale mailing address",
      after: { address: "12 Water St, St. John's, NL A1C 1A1" },
      sources: ["note_priya_move", "email_priya_move"],
      model: "claude-sonnet-5",
      traceId: "trace_plan33_crm",
    });
    expect(prop.status).toBe("pending");
    expect(prop.before["address"]).toContain("48 Duckworth St");

    const beforeApproval = await getClientProfile(pool, SARAH, "hh_priya_nair");
    expect(beforeApproval?.household.address).toContain("48 Duckworth St");

    // Marcus cannot see or approve Sarah's proposal (RLS).
    expect((await listProposals(pool, MARCUS)).some((p) => p.proposalId === prop.proposalId)).toBe(false);

    // Approving (with an optional edit) applies the change & appends to audit_log.
    const approved = await decideProposal(pool, SARAH, {
      proposalId: prop.proposalId,
      decision: "approve",
      editedAfter: { address: "12 Water St, Suite 2, St. John's, NL A1C 1A1" },
      actorId: "adv_sarah",
    });
    expect(approved.proposal.status).toBe("approved");
    expect(approved.auditEntry.action).toBe("crm_update_approved");
    expect(approved.auditEntry.targetTable).toBe("households");
    expect(approved.auditEntry.sources).toEqual(["note_priya_move", "email_priya_move"]);

    const afterApproval = await getClientProfile(pool, SARAH, "hh_priya_nair");
    expect(afterApproval?.household.address).toBe("12 Water St, Suite 2, St. John's, NL A1C 1A1");

    // Double-approval is rejected with ProposalConflictError.
    await expect(
      decideProposal(pool, SARAH, { proposalId: prop.proposalId, decision: "approve", actorId: "adv_sarah" }),
    ).rejects.toBeInstanceOf(ProposalConflictError);

    // Rejecting a task proposal leaves tasks unchanged and logs rejection.
    const taskProp = await createProposal(pool, SARAH, {
      clientId: "hh_chen_family",
      kind: "create_task",
      summary: "Schedule RESP drawdown call",
      after: { title: "Schedule RESP drawdown call", priority: "high", due_date: "2026-12-15" },
      sources: ["note_chen_tuition"],
      model: "claude-sonnet-5",
      traceId: "trace_plan33_task",
    });
    const rejected = await decideProposal(pool, SARAH, {
      proposalId: taskProp.proposalId,
      decision: "reject",
      actorId: "adv_sarah",
    });
    expect(rejected.proposal.status).toBe("rejected");
    expect(rejected.auditEntry.action).toBe("create_task_rejected");

    const audit = await listAuditLog(pool, SARAH, 20);
    expect(audit.some((a) => a.auditId === approved.auditEntry.auditId)).toBe(true);
    expect(audit.some((a) => a.auditId === rejected.auditEntry.auditId)).toBe(true);
  });
});
