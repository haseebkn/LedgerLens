import type { Pool } from "pg";
import { z } from "zod/v4";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { TenantContext } from "../db/client.js";
import {
  findClients,
  getClientActivity,
  getClientProfile,
  preparePortfolioReview,
  queryAdvisorWarehouse,
  searchNotesForAdvisor,
} from "../advisor/queries.js";
import {
  createProposal,
  CrmUpdateFieldsSchema,
  type ProposalRecord,
} from "../advisor/proposals.js";
import { ALLOWED_ADVISOR_VIEWS } from "../advisor/sql-guard-pg.js";

export interface AdvisorToolContext {
  pool: Pool;
  tenant: TenantContext;
  traceId: string;
  model: string;
  onProposalCreated?: (proposal: ProposalRecord) => void;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Builds the 8 advisor tools + Postgres read-only `query_warehouse` bound to
 * one advisor turn's tenant context, trace ID, and proposal callback.
 *
 * No tool mutates client records directly — write tools only create pending
 * proposals that require explicit advisor approval.
 */
export function makeAdvisorTools(ctx: AdvisorToolContext) {
  const findClientsTool = betaZodTool({
    name: "find_clients",
    description:
      "Filters the signed-in advisor's book of client households by holding ticker, minimum AUM, last review date, or name. " +
      "Use for questions like 'Which of my clients hold MSFT and haven't had a review in 6 months?'.",
    inputSchema: z
      .object({
        holding: z.string().trim().min(1).max(15).optional().describe("Ticker symbol held by the household, e.g. 'MSFT'."),
        min_aum: z.number().nonnegative().optional().describe("Minimum total household AUM in USD."),
        last_review_before: z
          .string()
          .regex(DATE_RE, "must be YYYY-MM-DD")
          .optional()
          .describe("Only return clients whose last_review_date is strictly before this YYYY-MM-DD date."),
        name: z.string().trim().min(1).max(120).optional().describe("Optional partial household name filter."),
      })
      .strict(),
    run: async (args) => {
      const result = await findClients(ctx.pool, ctx.tenant, {
        holding: args.holding,
        minAum: args.min_aum,
        lastReviewBefore: args.last_review_before,
        name: args.name,
      });
      return JSON.stringify(result, null, 2);
    },
  });

  const getClientProfileTool = betaZodTool({
    name: "get_client_profile",
    description:
      "Returns a household's full profile: CRM details (address, risk profile, targets, review dates), members, " +
      "accounts across custodians, recent meeting notes, and open tasks.",
    inputSchema: z
      .object({
        client_id: z.string().trim().min(1).max(120).describe("Household ID (e.g. 'hh_priya_nair') or client name (e.g. 'Priya Nair')."),
      })
      .strict(),
    run: async (args) => {
      const profile = await getClientProfile(ctx.pool, ctx.tenant, args.client_id);
      if (!profile) return `No client household matching "${args.client_id}" was found in your book.`;
      return JSON.stringify(profile, null, 2);
    },
  });

  const getClientActivityTool = betaZodTool({
    name: "get_client_activity",
    description:
      "Summarizes a client household's contributions (positive inflows), withdrawals (negative outflows), net cash flows, " +
      "and dividends over an optional date range. Use for 'How much did Priya Nair invest last month?'.",
    inputSchema: z
      .object({
        client_id: z.string().trim().min(1).max(120).describe("Household ID or client name."),
        start: z.string().regex(DATE_RE, "must be YYYY-MM-DD").optional().describe("Start date, inclusive (YYYY-MM-DD)."),
        end: z.string().regex(DATE_RE, "must be YYYY-MM-DD").optional().describe("End date, exclusive (YYYY-MM-DD)."),
      })
      .strict(),
    run: async (args) => {
      const activity = await getClientActivity(ctx.pool, ctx.tenant, {
        clientId: args.client_id,
        start: args.start,
        end: args.end,
      });
      if (!activity) return `No client household matching "${args.client_id}" was found in your book.`;
      return JSON.stringify(activity, null, 2);
    },
  });

  const searchNotesTool = betaZodTool({
    name: "search_notes",
    description:
      "Hybrid semantic (pgvector) + full-text search across meeting transcripts and client emails in the advisor's book. " +
      "Use for questions like 'What did the Chens say about their daughter's tuition?'.",
    inputSchema: z
      .object({
        query: z.string().trim().min(1).max(400).describe("Natural-language search query."),
        client_id: z.string().trim().min(1).max(120).optional().describe("Optional household ID or client name to narrow search."),
        limit: z.number().int().min(1).max(15).default(6).describe("Maximum hits to return."),
      })
      .strict(),
    run: async (args) => {
      const hits = await searchNotesForAdvisor(ctx.pool, ctx.tenant, {
        query: args.query,
        clientId: args.client_id,
        limit: args.limit,
      });
      if (hits.length === 0) {
        return `No meeting notes or emails matching "${args.query}" were found in your book.`;
      }
      return JSON.stringify(
        hits.map((h) => ({
          row_id: h.docId,
          doc_id: h.docId,
          kind: h.kind,
          household_id: h.householdId,
          household_name: h.householdName,
          date: h.date,
          title: h.title,
          snippet: h.snippet,
          score: Math.round(h.rrfScore * 10000) / 10000,
        })),
        null,
        2,
      );
    },
  });

  const preparePortfolioReviewTool = betaZodTool({
    name: "prepare_portfolio_review",
    description:
      "Computes deterministic portfolio-review metrics for a household: total AUM across custodians, actual vs. target " +
      "allocation and drift, weighted YTD return, top holdings with unrealized gains, 12-month cash flows, recent notes, and open tasks.",
    inputSchema: z
      .object({
        client_id: z.string().trim().min(1).max(120).describe("Household ID or client name."),
      })
      .strict(),
    run: async (args) => {
      const review = await preparePortfolioReview(ctx.pool, ctx.tenant, args.client_id);
      if (!review) return `No client household matching "${args.client_id}" was found in your book.`;
      return JSON.stringify(review, null, 2);
    },
  });

  const proposeCrmUpdateTool = betaZodTool({
    name: "propose_crm_update",
    description:
      "Creates a PENDING proposal to update allowlisted CRM fields on a client household (address, phone, primary_email, " +
      "risk_profile, next_review_date, notes_summary). Does NOT modify client data until the advisor explicitly approves.",
    inputSchema: z
      .object({
        client_id: z.string().trim().min(1).max(120).describe("Household ID or client name."),
        summary: z.string().trim().min(1).max(300).describe("Short explanation of the proposed CRM update."),
        changes: CrmUpdateFieldsSchema.describe("CRM fields and new values to propose."),
        sources: z.array(z.string().trim().min(1)).default([]).describe("Supporting citation IDs (e.g. ['note_priya_move'])."),
      })
      .strict(),
    run: async (args) => {
      const proposal = await createProposal(ctx.pool, ctx.tenant, {
        clientId: args.client_id,
        kind: "crm_update",
        summary: args.summary,
        after: args.changes as Record<string, unknown>,
        sources: args.sources,
        model: ctx.model,
        traceId: ctx.traceId,
      });
      ctx.onProposalCreated?.(proposal);
      return JSON.stringify({ proposal_id: proposal.proposalId, status: proposal.status, proposal }, null, 2);
    },
  });

  const draftFollowUpTool = betaZodTool({
    name: "draft_follow_up",
    description:
      "Creates a PENDING follow-up email draft proposal for a client household. Nothing is sent or logged as outbound until the advisor approves.",
    inputSchema: z
      .object({
        client_id: z.string().trim().min(1).max(120).describe("Household ID or client name."),
        summary: z.string().trim().min(1).max(300).describe("Short description of the follow-up email."),
        recipient: z.string().trim().email().describe("Client email address."),
        subject: z.string().trim().min(1).max(200).describe("Email subject line."),
        body: z.string().trim().min(1).max(4000).describe("Email body text."),
        sources: z.array(z.string().trim().min(1)).default([]).describe("Supporting citation IDs."),
      })
      .strict(),
    run: async (args) => {
      const proposal = await createProposal(ctx.pool, ctx.tenant, {
        clientId: args.client_id,
        kind: "draft_follow_up",
        summary: args.summary,
        after: { recipient: args.recipient, subject: args.subject, body: args.body },
        sources: args.sources,
        model: ctx.model,
        traceId: ctx.traceId,
      });
      ctx.onProposalCreated?.(proposal);
      return JSON.stringify({ proposal_id: proposal.proposalId, status: proposal.status, proposal }, null, 2);
    },
  });

  const createTaskTool = betaZodTool({
    name: "create_task",
    description:
      "Creates a PENDING proposal to add a follow-up task for a client household. Nothing is created until the advisor approves.",
    inputSchema: z
      .object({
        client_id: z.string().trim().min(1).max(120).describe("Household ID or client name."),
        summary: z.string().trim().min(1).max(300).describe("Short description of the proposed task."),
        title: z.string().trim().min(1).max(300).describe("Task title."),
        priority: z.enum(["low", "medium", "high"]).default("medium"),
        due_date: z.string().regex(DATE_RE, "must be YYYY-MM-DD").optional().describe("Optional due date (YYYY-MM-DD)."),
        sources: z.array(z.string().trim().min(1)).default([]).describe("Supporting citation IDs."),
      })
      .strict(),
    run: async (args) => {
      const proposal = await createProposal(ctx.pool, ctx.tenant, {
        clientId: args.client_id,
        kind: "create_task",
        summary: args.summary,
        after: { title: args.title, priority: args.priority, ...(args.due_date ? { due_date: args.due_date } : {}) },
        sources: args.sources,
        model: ctx.model,
        traceId: ctx.traceId,
      });
      ctx.onProposalCreated?.(proposal);
      return JSON.stringify({ proposal_id: proposal.proposalId, status: proposal.status, proposal }, null, 2);
    },
  });

  const queryAdvisorWarehouseTool = betaZodTool({
    name: "query_warehouse",
    description:
      "Runs a read-only Postgres SELECT query against allowlisted advisor views under Row-Level Security and a 5-second timeout. " +
      `Available views: ${[...ALLOWED_ADVISOR_VIEWS].join(", ")}. Prefer the structured advisor tools first.`,
    inputSchema: z
      .object({
        sql: z.string().min(1).describe("Single read-only Postgres SELECT query against allowlisted v_* views."),
      })
      .strict(),
    run: async (args) => {
      const result = await queryAdvisorWarehouse(ctx.pool, ctx.tenant, args.sql);
      return JSON.stringify(result, null, 2);
    },
  });

  return [
    findClientsTool,
    getClientProfileTool,
    getClientActivityTool,
    searchNotesTool,
    preparePortfolioReviewTool,
    proposeCrmUpdateTool,
    draftFollowUpTool,
    createTaskTool,
    queryAdvisorWarehouseTool,
  ] as const;
}
