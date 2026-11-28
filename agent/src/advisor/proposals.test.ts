import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { CrmUpdateFieldsSchema, CreateTaskFieldsSchema, DraftFollowUpSchema } from "./proposals.js";
import { makeAdvisorTools } from "../tools/advisor-tools.js";

describe("Advisor proposals schemas & toolset", () => {
  it("allows only explicit CRM fields and rejects tenancy or empty mutations", () => {
    expect(CrmUpdateFieldsSchema.safeParse({ address: "12 Water St, St. John's, NL" }).success).toBe(true);
    expect(CrmUpdateFieldsSchema.safeParse({}).success).toBe(false);
    expect(CrmUpdateFieldsSchema.safeParse({ advisor_id: "adv_marcus" }).success).toBe(false);
    expect(CrmUpdateFieldsSchema.safeParse({ firm_id: "evil_firm" }).success).toBe(false);
  });

  it("validates follow-up email drafts and tasks strictly", () => {
    expect(
      DraftFollowUpSchema.safeParse({
        recipient: "priya.nair@example.com",
        subject: "Portfolio review follow-up",
        body: "Thanks for meeting today.",
      }).success,
    ).toBe(true);
    expect(DraftFollowUpSchema.safeParse({ recipient: "not-an-email", subject: "Hi", body: "Text" }).success).toBe(false);

    expect(CreateTaskFieldsSchema.safeParse({ title: "Confirm wire", priority: "high", due_date: "2026-12-10" }).success).toBe(true);
    expect(CreateTaskFieldsSchema.safeParse({ title: "Confirm wire", due_date: "next week" }).success).toBe(false);
  });

  it("exposes all 8 structured advisor tools plus read-only query_warehouse", () => {
    const tools = makeAdvisorTools({
      pool: {} as Pool,
      tenant: { firmId: "firm_atlantic_wealth", advisorId: "adv_sarah" },
      traceId: "trace_test",
      model: "claude-sonnet-5",
    });
    expect(tools.map((t) => t.name)).toEqual([
      "find_clients",
      "get_client_profile",
      "get_client_activity",
      "search_notes",
      "prepare_portfolio_review",
      "propose_crm_update",
      "draft_follow_up",
      "create_task",
      "query_warehouse",
    ]);
  });
});
