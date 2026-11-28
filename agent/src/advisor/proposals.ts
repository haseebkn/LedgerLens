import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod/v4";
import { withTenantContext, type TenantContext } from "../db/client.js";
import { embedTexts, toPgVectorLiteral } from "../db/embeddings.js";
import { resolveHousehold } from "./queries.js";

/**
 * Governance boundary for all advisor write intents (Plan 3.3).
 *
 * Invariant: NO agent tool writes to households, tasks, or emails directly.
 * Agent tools only call `createProposal`, which inserts a `status = 'pending'`
 * row into `proposals`. Client data changes ONLY inside `decideProposal(...,
 * "approve")`, which applies the diff atomically and appends an immutable
 * entry to `audit_log`.
 */

export const CrmUpdateFieldsSchema = z
  .object({
    address: z.string().trim().min(1).max(300).optional(),
    phone: z.string().trim().min(1).max(50).optional(),
    primary_email: z.string().trim().email().max(200).optional(),
    risk_profile: z.enum(["conservative", "balanced", "growth"]).optional(),
    next_review_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").optional(),
    notes_summary: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .refine((obj) => Object.keys(obj).length > 0, { message: "At least one CRM field must be specified" });

export const DraftFollowUpSchema = z
  .object({
    recipient: z.string().trim().email().max(200),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();

export const CreateTaskFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").optional(),
  })
  .strict();

export type ProposalKind = "crm_update" | "draft_follow_up" | "create_task";
export type ProposalStatus = "pending" | "approved" | "rejected";

export interface ProposalRecord {
  proposalId: string;
  householdId: string;
  householdName: string;
  kind: ProposalKind;
  status: ProposalStatus;
  summary: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  sources: string[];
  model: string;
  traceId: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface AuditLogRecord {
  auditId: string;
  proposalId: string | null;
  action: string;
  actorId: string;
  targetTable: string;
  targetId: string;
  diff: Record<string, unknown>;
  sources: string[];
  model: string;
  traceId: string;
  createdAt: string;
}

const ALLOWED_CRM_COLUMNS: Record<string, string> = {
  address: "address",
  phone: "phone",
  primary_email: "primary_email",
  risk_profile: "risk_profile",
  next_review_date: "next_review_date",
  notes_summary: "notes_summary",
};

function mapProposalRow(row: Record<string, unknown>): ProposalRecord {
  return {
    proposalId: String(row["proposal_id"]),
    householdId: String(row["household_id"]),
    householdName: String(row["household_name"] ?? row["household_id"]),
    kind: row["kind"] as ProposalKind,
    status: row["status"] as ProposalStatus,
    summary: String(row["summary"]),
    before: (row["before_json"] as Record<string, unknown>) ?? {},
    after: (row["after_json"] as Record<string, unknown>) ?? {},
    sources: (row["sources"] as string[] | null) ?? [],
    model: String(row["model"]),
    traceId: String(row["trace_id"]),
    createdAt: String(row["created_at"]),
    decidedAt: row["decided_at"] ? String(row["decided_at"]) : null,
    decidedBy: row["decided_by"] ? String(row["decided_by"]) : null,
  };
}

export async function createProposal(
  pool: Pool,
  ctx: TenantContext,
  input: {
    clientId: string;
    kind: ProposalKind;
    summary: string;
    after: Record<string, unknown>;
    sources: string[];
    model: string;
    traceId: string;
  },
): Promise<ProposalRecord> {
  const validatedAfter =
    input.kind === "crm_update"
      ? CrmUpdateFieldsSchema.parse(input.after)
      : input.kind === "draft_follow_up"
        ? DraftFollowUpSchema.parse(input.after)
        : CreateTaskFieldsSchema.parse(input.after);

  return withTenantContext(
    pool,
    ctx,
    async (client) => {
      const resolved = await resolveHousehold(client, input.clientId);
      if (!resolved) {
        throw new Error(`Household "${input.clientId}" not found in your book.`);
      }

      let beforeJson: Record<string, unknown> = {};
      if (input.kind === "crm_update") {
        const hhRes = await client.query(
          `SELECT address, phone, primary_email, risk_profile, next_review_date::text AS next_review_date, notes_summary
           FROM households WHERE household_id = $1`,
          [resolved.householdId],
        );
        const current = hhRes.rows[0] as Record<string, unknown>;
        for (const key of Object.keys(validatedAfter)) {
          beforeJson[key] = current[key] ?? null;
        }
      }

      const proposalId = `prop_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const res = await client.query(
        `INSERT INTO proposals (
           proposal_id, firm_id, advisor_id, household_id, kind, status, summary,
           before_json, after_json, sources, model, trace_id
         ) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7::jsonb,$8::jsonb,$9,$10,$11)
         RETURNING *, $12::text AS household_name`,
        [
          proposalId,
          ctx.firmId,
          ctx.advisorId,
          resolved.householdId,
          input.kind,
          input.summary,
          JSON.stringify(beforeJson),
          JSON.stringify(validatedAfter),
          input.sources,
          input.model,
          input.traceId,
          resolved.name,
        ],
      );
      return mapProposalRow(res.rows[0] as Record<string, unknown>);
    },
    { role: process.env.DB_APP_ROLE, statementTimeoutMs: 5_000 },
  );
}

export async function listProposals(
  pool: Pool,
  ctx: TenantContext,
  params?: { status?: ProposalStatus; householdId?: string },
): Promise<ProposalRecord[]> {
  return withTenantContext(
    pool,
    ctx,
    async (client) => {
      const res = await client.query(
        `SELECT p.*, h.name AS household_name
         FROM proposals p
         JOIN households h ON h.household_id = p.household_id
         WHERE ($1::text IS NULL OR p.status = $1)
           AND ($2::text IS NULL OR p.household_id = $2)
         ORDER BY CASE WHEN p.status = 'pending' THEN 0 ELSE 1 END, p.created_at DESC
         LIMIT 100`,
        [params?.status ?? null, params?.householdId ?? null],
      );
      return res.rows.map((r) => mapProposalRow(r as Record<string, unknown>));
    },
    { readOnly: true, role: process.env.DB_APP_ROLE, statementTimeoutMs: 5_000 },
  );
}

export class ProposalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalConflictError";
  }
}

export class ProposalNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalNotFoundError";
  }
}

/**
 * Atomically approves (with optional advisor edits) or rejects a pending
 * proposal, applies the change when approved, and appends an immutable entry
 * to `audit_log`.
 */
export async function decideProposal(
  pool: Pool,
  ctx: TenantContext,
  params: {
    proposalId: string;
    decision: "approve" | "reject";
    editedAfter?: Record<string, unknown>;
    actorId: string;
  },
): Promise<{ proposal: ProposalRecord; auditEntry: AuditLogRecord }> {
  return withTenantContext(
    pool,
    ctx,
    async (client) => {
      const existing = await client.query(
        `SELECT p.*, h.name AS household_name
         FROM proposals p
         JOIN households h ON h.household_id = p.household_id
         WHERE p.proposal_id = $1
         FOR UPDATE OF p`,
        [params.proposalId],
      );
      const row = existing.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        throw new ProposalNotFoundError(`Proposal "${params.proposalId}" not found.`);
      }
      if (row["status"] !== "pending") {
        throw new ProposalConflictError(`Proposal "${params.proposalId}" is already ${row["status"]}.`);
      }

      const kind = row["kind"] as ProposalKind;
      const householdId = String(row["household_id"]);
      const beforeJson = (row["before_json"] as Record<string, unknown>) ?? {};
      const originalAfter = (row["after_json"] as Record<string, unknown>) ?? {};
      const sources = (row["sources"] as string[] | null) ?? [];
      const model = String(row["model"]);
      const traceId = String(row["trace_id"]);

      const finalAfter =
        params.decision === "approve" && params.editedAfter
          ? kind === "crm_update"
            ? CrmUpdateFieldsSchema.parse({ ...originalAfter, ...params.editedAfter })
            : kind === "draft_follow_up"
              ? DraftFollowUpSchema.parse({ ...originalAfter, ...params.editedAfter })
              : CreateTaskFieldsSchema.parse({ ...originalAfter, ...params.editedAfter })
          : originalAfter;

      const nextStatus: ProposalStatus = params.decision === "approve" ? "approved" : "rejected";
      let targetTable = "proposals";
      let targetId = params.proposalId;
      const diffJson: Record<string, unknown> = {};

      if (params.decision === "approve") {
        if (kind === "crm_update") {
          targetTable = "households";
          targetId = householdId;
          const setClauses: string[] = [];
          const values: unknown[] = [];
          for (const [key, val] of Object.entries(finalAfter)) {
            const col = ALLOWED_CRM_COLUMNS[key];
            if (!col) throw new Error(`Field "${key}" is not allowed in CRM updates.`);
            values.push(val);
            setClauses.push(`${col} = $${values.length}`);
            diffJson[key] = { old: beforeJson[key] ?? null, new: val };
          }
          values.push(householdId);
          await client.query(
            `UPDATE households SET ${setClauses.join(", ")}, updated_at = now() WHERE household_id = $${values.length}`,
            values,
          );
        } else if (kind === "create_task") {
          targetTable = "tasks";
          const taskId = `task_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
          targetId = taskId;
          const taskData = CreateTaskFieldsSchema.parse(finalAfter);
          await client.query(
            `INSERT INTO tasks (task_id, firm_id, advisor_id, household_id, title, status, priority, due_date, source_ref)
             VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8)`,
            [
              taskId,
              ctx.firmId,
              ctx.advisorId,
              householdId,
              taskData.title,
              taskData.priority,
              taskData.due_date ?? null,
              sources[0] ?? params.proposalId,
            ],
          );
          diffJson["task"] = { old: null, new: { task_id: taskId, ...taskData } };
        } else if (kind === "draft_follow_up") {
          targetTable = "emails";
          const emailId = `email_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
          targetId = emailId;
          const draft = DraftFollowUpSchema.parse(finalAfter);
          const advRes = await client.query<{ email: string }>(
            `SELECT email FROM advisors WHERE advisor_id = $1`,
            [ctx.advisorId],
          );
          const sender = advRes.rows[0]?.email ?? `${ctx.advisorId}@atlanticharbour.example`;
          const [vec] = await embedTexts([`${draft.subject}\n${draft.body}`]);
          await client.query(
            `INSERT INTO emails (email_id, firm_id, advisor_id, household_id, sent_at, direction, sender, recipient, subject, body, embedding)
             VALUES ($1,$2,$3,$4,now(),'outbound',$5,$6,$7,$8,$9::vector)`,
            [emailId, ctx.firmId, ctx.advisorId, householdId, sender, draft.recipient, draft.subject, draft.body, toPgVectorLiteral(vec!)],
          );
          diffJson["email"] = { old: null, new: { email_id: emailId, recipient: draft.recipient, subject: draft.subject } };
        }
      } else {
        diffJson["rejected_proposal"] = { before: beforeJson, proposed_after: originalAfter };
      }

      const updatedProp = await client.query(
        `UPDATE proposals
         SET status = $1, after_json = $2::jsonb, decided_at = now(), decided_by = $3
         WHERE proposal_id = $4
         RETURNING *, $5::text AS household_name`,
        [nextStatus, JSON.stringify(finalAfter), params.actorId, params.proposalId, String(row["household_name"])],
      );

      const auditId = `audit_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const action = params.decision === "approve" ? `${kind}_approved` : `${kind}_rejected`;
      const auditRes = await client.query(
        `INSERT INTO audit_log (
           audit_id, firm_id, advisor_id, proposal_id, action, actor_id,
           target_table, target_id, diff_json, sources, model, trace_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
         RETURNING *`,
        [
          auditId,
          ctx.firmId,
          ctx.advisorId,
          params.proposalId,
          action,
          params.actorId,
          targetTable,
          targetId,
          JSON.stringify(diffJson),
          sources,
          model,
          traceId,
        ],
      );

      const ar = auditRes.rows[0] as Record<string, unknown>;
      return {
        proposal: mapProposalRow(updatedProp.rows[0] as Record<string, unknown>),
        auditEntry: {
          auditId: String(ar["audit_id"]),
          proposalId: ar["proposal_id"] ? String(ar["proposal_id"]) : null,
          action: String(ar["action"]),
          actorId: String(ar["actor_id"]),
          targetTable: String(ar["target_table"]),
          targetId: String(ar["target_id"]),
          diff: (ar["diff_json"] as Record<string, unknown>) ?? {},
          sources: (ar["sources"] as string[] | null) ?? [],
          model: String(ar["model"]),
          traceId: String(ar["trace_id"]),
          createdAt: String(ar["created_at"]),
        },
      };
    },
    { role: process.env.DB_APP_ROLE, statementTimeoutMs: 5_000 },
  );
}

export async function listAuditLog(pool: Pool, ctx: TenantContext, limit = 50): Promise<AuditLogRecord[]> {
  return withTenantContext(
    pool,
    ctx,
    async (client) => {
      const res = await client.query(
        `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1`,
        [Math.max(1, Math.min(200, limit))],
      );
      return res.rows.map((ar) => ({
        auditId: String(ar["audit_id"]),
        proposalId: ar["proposal_id"] ? String(ar["proposal_id"]) : null,
        action: String(ar["action"]),
        actorId: String(ar["actor_id"]),
        targetTable: String(ar["target_table"]),
        targetId: String(ar["target_id"]),
        diff: (ar["diff_json"] as Record<string, unknown>) ?? {},
        sources: (ar["sources"] as string[] | null) ?? [],
        model: String(ar["model"]),
        traceId: String(ar["trace_id"]),
        createdAt: String(ar["created_at"]),
      }));
    },
    { readOnly: true, role: process.env.DB_APP_ROLE, statementTimeoutMs: 5_000 },
  );
}
