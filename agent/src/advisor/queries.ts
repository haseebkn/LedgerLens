import type { Pool, PoolClient } from "pg";
import { withTenantContext, type TenantContext } from "../db/client.js";
import { searchAdvisorNotes, type NoteSearchHit } from "../db/advisor-repo.js";
import { createResultId } from "../lib/result-id.js";
import { rememberComputedResult } from "../lib/result-store.js";
import { guardPgSql } from "./sql-guard-pg.js";

/**
 * Deterministic, parameterized advisor queries running strictly inside
 * Postgres Row-Level Security (`withTenantContext`). Every aggregate and
 * computed report stores a content-hashed `computed_*` result in result-store
 * so citations open cleanly in the UI source drawer.
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Resolves either an exact household_id or a case-insensitive household/member name within RLS. */
export async function resolveHousehold(
  client: PoolClient,
  clientIdOrName: string,
): Promise<{ householdId: string; name: string } | null> {
  const input = clientIdOrName.trim();
  if (!input) return null;

  const exact = await client.query<{ household_id: string; name: string }>(
    `SELECT household_id, name FROM households WHERE household_id = $1 LIMIT 1`,
    [input],
  );
  if (exact.rows[0]) {
    return { householdId: exact.rows[0].household_id, name: exact.rows[0].name };
  }

  const byName = await client.query<{ household_id: string; name: string }>(
    `SELECT DISTINCT h.household_id, h.name
     FROM households h
     LEFT JOIN household_members m ON m.household_id = h.household_id
     WHERE h.name ILIKE $1 OR m.full_name ILIKE $1
     ORDER BY h.name ASC
     LIMIT 10`,
    [`%${input}%`],
  );

  if (byName.rows.length === 0) return null;
  if (byName.rows.length === 1) {
    return { householdId: byName.rows[0]!.household_id, name: byName.rows[0]!.name };
  }
  // Prefer exact case-insensitive household name match before failing ambiguously.
  const exactName = byName.rows.find((r) => r.name.toLowerCase() === input.toLowerCase());
  if (exactName) return { householdId: exactName.household_id, name: exactName.name };

  const options = byName.rows.map((r) => `${r.name} (${r.household_id})`).join(", ");
  throw new Error(`Ambiguous client "${clientIdOrName}". Matching households: ${options}. Pass the exact household_id.`);
}

export async function findClients(
  pool: Pool,
  ctx: TenantContext,
  params: { holding?: string; minAum?: number; lastReviewBefore?: string; name?: string; limit?: number },
) {
  if (params.lastReviewBefore && !DATE_RE.test(params.lastReviewBefore)) {
    throw new Error("last_review_before must be YYYY-MM-DD");
  }
  const holding = params.holding?.trim().toUpperCase() || null;
  const minAum = params.minAum ?? null;
  const lastReviewBefore = params.lastReviewBefore ?? null;
  const namePattern = params.name?.trim() ? `%${params.name.trim()}%` : null;
  const limit = Math.max(1, Math.min(100, params.limit ?? 50));

  const sql = `
    WITH aum_by_hh AS (
      SELECT
        household_id,
        ROUND(SUM(market_value)::numeric, 2)::double precision AS total_aum,
        COUNT(*)::int AS account_count,
        ARRAY_AGG(DISTINCT custodian ORDER BY custodian) AS custodians
      FROM accounts
      WHERE status = 'active'
      GROUP BY household_id
    ),
    holding_by_hh AS (
      SELECT
        household_id,
        ROUND(SUM(market_value)::numeric, 2)::double precision AS holding_value,
        ROUND(SUM(quantity)::numeric, 4)::double precision AS holding_shares
      FROM positions
      WHERE ($1::text IS NOT NULL AND UPPER(symbol) = $1)
      GROUP BY household_id
    )
    SELECT
      h.household_id,
      h.name,
      h.risk_profile,
      h.last_review_date::text AS last_review_date,
      h.next_review_date::text AS next_review_date,
      COALESCE(a.total_aum, 0) AS total_aum,
      COALESCE(a.account_count, 0) AS account_count,
      COALESCE(a.custodians, ARRAY[]::text[]) AS custodians,
      p.holding_value,
      p.holding_shares
    FROM households h
    LEFT JOIN aum_by_hh a ON a.household_id = h.household_id
    LEFT JOIN holding_by_hh p ON p.household_id = h.household_id
    WHERE ($1::text IS NULL OR p.household_id IS NOT NULL)
      AND ($2::double precision IS NULL OR COALESCE(a.total_aum, 0) >= $2)
      AND ($3::date IS NULL OR h.last_review_date < $3)
      AND ($4::text IS NULL OR h.name ILIKE $4)
    ORDER BY COALESCE(a.total_aum, 0) DESC, h.name ASC
    LIMIT $5
  `;

  const values = [holding, minAum, lastReviewBefore, namePattern, limit];
  const rows = await withTenantContext(
    pool,
    ctx,
    async (client) => (await client.query(sql, values)).rows,
    { readOnly: true, role: process.env.DB_APP_ROLE, statementTimeoutMs: 5_000 },
  );

  const payload = {
    filters: { holding, min_aum: minAum, last_review_before: lastReviewBefore, name: params.name ?? null },
    client_count: rows.length,
    clients: rows.map((r) => ({
      row_id: String(r["household_id"]),
      household_id: String(r["household_id"]),
      name: String(r["name"]),
      risk_profile: String(r["risk_profile"]),
      last_review_date: String(r["last_review_date"]),
      next_review_date: r["next_review_date"] ? String(r["next_review_date"]) : null,
      total_aum: round2(Number(r["total_aum"] ?? 0)),
      account_count: Number(r["account_count"] ?? 0),
      custodians: (r["custodians"] as string[] | null) ?? [],
      ...(holding
        ? {
            holding_symbol: holding,
            holding_value: round2(Number(r["holding_value"] ?? 0)),
            holding_shares: Number(r["holding_shares"] ?? 0),
          }
        : {}),
    })),
  };

  const resultId = createResultId("clients", payload);
  rememberComputedResult({
    resultId,
    kind: "query",
    sql: sql.trim(),
    params: values,
    rows: payload.clients as unknown as Record<string, unknown>[],
    summary: { client_count: payload.client_count, ...payload.filters },
  });

  return { result_id: resultId, ...payload };
}

export async function getClientProfile(pool: Pool, ctx: TenantContext, clientIdOrName: string) {
  return withTenantContext(
    pool,
    ctx,
    async (client) => {
      const resolved = await resolveHousehold(client, clientIdOrName);
      if (!resolved) return null;

      const [hhRes, memRes, acctRes, notesRes, tasksRes] = await Promise.all([
        client.query(
          `SELECT household_id, name, primary_email, phone, address, risk_profile,
                  target_equity_pct, target_fixed_income_pct, target_cash_pct,
                  last_review_date::text AS last_review_date, next_review_date::text AS next_review_date,
                  notes_summary, updated_at::text AS updated_at
           FROM households WHERE household_id = $1`,
          [resolved.householdId],
        ),
        client.query(
          `SELECT member_id, full_name, role, email, date_of_birth::text AS date_of_birth
           FROM household_members WHERE household_id = $1 ORDER BY role, full_name`,
          [resolved.householdId],
        ),
        client.query(
          `SELECT account_id, custodian, account_number, account_type, status,
                  cash_balance::double precision AS cash_balance,
                  market_value::double precision AS market_value,
                  ytd_return_pct::double precision AS ytd_return_pct,
                  as_of_date::text AS as_of_date
           FROM accounts WHERE household_id = $1 ORDER BY market_value DESC`,
          [resolved.householdId],
        ),
        client.query(
          `SELECT note_id, meeting_date::text AS meeting_date, title, attendees, LEFT(transcript, 300) AS preview
           FROM meeting_notes WHERE household_id = $1 ORDER BY meeting_date DESC LIMIT 5`,
          [resolved.householdId],
        ),
        client.query(
          `SELECT task_id, title, status, priority, due_date::text AS due_date, source_ref
           FROM tasks WHERE household_id = $1 AND status = 'open' ORDER BY due_date ASC NULLS LAST`,
          [resolved.householdId],
        ),
      ]);

      const hh = hhRes.rows[0]!;
      const totalAum = round2(acctRes.rows.reduce((s, a) => s + Number(a["market_value"] ?? 0), 0));
      const custodians = [...new Set(acctRes.rows.map((a) => String(a["custodian"])))];

      return {
        row_id: String(hh["household_id"]),
        household: {
          ...hh,
          total_aum: totalAum,
          custodians,
          multi_custodian: custodians.length > 1,
        },
        members: memRes.rows,
        accounts: acctRes.rows.map((a) => ({ row_id: String(a["account_id"]), ...a })),
        recent_meetings: notesRes.rows.map((n) => ({ row_id: String(n["note_id"]), ...n })),
        open_tasks: tasksRes.rows.map((t) => ({ row_id: String(t["task_id"]), ...t })),
      };
    },
    { readOnly: true, role: process.env.DB_APP_ROLE, statementTimeoutMs: 5_000 },
  );
}

/**
 * Deterministic cash-flow & investment activity summary for one household.
 * Sign convention:
 * - contribution: positive inflow (+amount)
 * - withdrawal: negative outflow (-amount)
 * - net_contributions = contributions + withdrawals (net cash invested)
 */
export async function getClientActivity(
  pool: Pool,
  ctx: TenantContext,
  params: { clientId: string; start?: string; end?: string },
) {
  if (params.start && !DATE_RE.test(params.start)) throw new Error("start must be YYYY-MM-DD");
  if (params.end && !DATE_RE.test(params.end)) throw new Error("end must be YYYY-MM-DD");

  return withTenantContext(
    pool,
    ctx,
    async (client) => {
      const resolved = await resolveHousehold(client, params.clientId);
      if (!resolved) return null;

      const sql = `
        SELECT
          transaction_id,
          account_id,
          txn_type,
          symbol,
          quantity::double precision AS quantity,
          amount::double precision AS amount,
          txn_date::text AS txn_date,
          description,
          custodian
        FROM transactions
        WHERE household_id = $1
          AND ($2::date IS NULL OR txn_date >= $2)
          AND ($3::date IS NULL OR txn_date < $3)
        ORDER BY txn_date DESC, transaction_id ASC
      `;
      const values = [resolved.householdId, params.start ?? null, params.end ?? null];
      const rows = (await client.query(sql, values)).rows;

      let contributions = 0;
      let withdrawals = 0;
      let dividends = 0;
      let fees = 0;
      let contributionCount = 0;
      let withdrawalCount = 0;

      for (const r of rows) {
        const amt = Number(r["amount"] ?? 0);
        const kind = String(r["txn_type"]);
        if (kind === "contribution") {
          contributions += amt;
          contributionCount++;
        } else if (kind === "withdrawal") {
          withdrawals += amt;
          withdrawalCount++;
        } else if (kind === "dividend") {
          dividends += amt;
        } else if (kind === "fee") {
          fees += amt;
        }
      }

      const payload = {
        household_id: resolved.householdId,
        household_name: resolved.name,
        period: {
          start: params.start ?? (rows.length > 0 ? String(rows[rows.length - 1]!["txn_date"]) : null),
          end: params.end ?? (rows.length > 0 ? String(rows[0]!["txn_date"]) : null),
        },
        sign_convention: "contributions are positive inflows, withdrawals are negative outflows, net_flows = contributions + withdrawals",
        totals: {
          contributions: round2(contributions),
          withdrawals: round2(withdrawals),
          net_flows: round2(contributions + withdrawals),
          dividends: round2(dividends),
          fees: round2(fees),
          contribution_count: contributionCount,
          withdrawal_count: withdrawalCount,
          transaction_count: rows.length,
        },
        transactions: rows.slice(0, 50).map((r) => ({
          row_id: String(r["transaction_id"]),
          transaction_id: String(r["transaction_id"]),
          account_id: String(r["account_id"]),
          txn_type: String(r["txn_type"]),
          symbol: r["symbol"] ? String(r["symbol"]) : null,
          quantity: r["quantity"] == null ? null : Number(r["quantity"]),
          amount: round2(Number(r["amount"] ?? 0)),
          txn_date: String(r["txn_date"]),
          description: String(r["description"]),
          custodian: String(r["custodian"]),
        })),
      };

      const resultId = createResultId("activity", payload);
      rememberComputedResult({
        resultId,
        kind: "spend",
        sql: sql.trim(),
        params: values,
        rows: payload.transactions as unknown as Record<string, unknown>[],
        summary: { household: resolved.name, ...payload.totals, ...payload.period },
      });

      return { result_id: resultId, ...payload };
    },
    { readOnly: true, role: process.env.DB_APP_ROLE, statementTimeoutMs: 5_000 },
  );
}

/**
 * Deterministic portfolio-review numbers for one household: AUM across
 * custodians, allocation vs. target & drift, weighted YTD return, top holdings
 * with unrealized gains, 12-month cash flows, recent notes, and open tasks.
 */
export async function preparePortfolioReview(pool: Pool, ctx: TenantContext, clientIdOrName: string) {
  return withTenantContext(
    pool,
    ctx,
    async (client) => {
      const resolved = await resolveHousehold(client, clientIdOrName);
      if (!resolved) return null;

      const [hhRes, acctRes, posRes, flowRes, notesRes, tasksRes] = await Promise.all([
        client.query(
          `SELECT household_id, name, address, risk_profile,
                  target_equity_pct, target_fixed_income_pct, target_cash_pct,
                  last_review_date::text AS last_review_date, next_review_date::text AS next_review_date
           FROM households WHERE household_id = $1`,
          [resolved.householdId],
        ),
        client.query(
          `SELECT account_id, custodian, account_type, account_number,
                  cash_balance::double precision AS cash_balance,
                  market_value::double precision AS market_value,
                  ytd_return_pct::double precision AS ytd_return_pct,
                  as_of_date::text AS as_of_date
           FROM accounts WHERE household_id = $1 AND status = 'active' ORDER BY market_value DESC`,
          [resolved.householdId],
        ),
        client.query(
          `SELECT position_id, account_id, symbol, asset_class,
                  quantity::double precision AS quantity,
                  market_price::double precision AS market_price,
                  market_value::double precision AS market_value,
                  cost_basis::double precision AS cost_basis
           FROM positions WHERE household_id = $1 ORDER BY market_value DESC`,
          [resolved.householdId],
        ),
        client.query(
          `SELECT
             COALESCE(SUM(CASE WHEN txn_type = 'contribution' THEN amount ELSE 0 END), 0)::double precision AS contributions,
             COALESCE(SUM(CASE WHEN txn_type = 'withdrawal' THEN amount ELSE 0 END), 0)::double precision AS withdrawals,
             COALESCE(SUM(CASE WHEN txn_type = 'dividend' THEN amount ELSE 0 END), 0)::double precision AS dividends,
             COUNT(*)::int AS txn_count
           FROM transactions WHERE household_id = $1`,
          [resolved.householdId],
        ),
        client.query(
          `SELECT note_id, meeting_date::text AS meeting_date, title, LEFT(transcript, 350) AS excerpt
           FROM meeting_notes WHERE household_id = $1 ORDER BY meeting_date DESC LIMIT 3`,
          [resolved.householdId],
        ),
        client.query(
          `SELECT task_id, title, priority, due_date::text AS due_date
           FROM tasks WHERE household_id = $1 AND status = 'open' ORDER BY due_date ASC NULLS LAST`,
          [resolved.householdId],
        ),
      ]);

      const hh = hhRes.rows[0]!;
      const totalAum = round2(acctRes.rows.reduce((s, a) => s + Number(a["market_value"] ?? 0), 0));
      const totalCashAccounts = round2(acctRes.rows.reduce((s, a) => s + Number(a["cash_balance"] ?? 0), 0));

      let equityVal = 0;
      let fixedIncomeVal = 0;
      let cashVal = totalCashAccounts;
      const bySymbol = new Map<
        string,
        { symbol: string; asset_class: string; shares: number; market_value: number; cost_basis: number; position_ids: string[] }
      >();

      for (const p of posRes.rows) {
        const mv = Number(p["market_value"] ?? 0);
        const cb = Number(p["cost_basis"] ?? 0);
        const qty = Number(p["quantity"] ?? 0);
        const cls = String(p["asset_class"]);
        if (cls === "equity") equityVal += mv;
        else if (cls === "fixed_income") fixedIncomeVal += mv;
        else cashVal += mv;

        const sym = String(p["symbol"]);
        const existing = bySymbol.get(sym) ?? {
          symbol: sym,
          asset_class: cls,
          shares: 0,
          market_value: 0,
          cost_basis: 0,
          position_ids: [],
        };
        existing.shares = round2(existing.shares + qty);
        existing.market_value = round2(existing.market_value + mv);
        existing.cost_basis = round2(existing.cost_basis + cb);
        existing.position_ids.push(String(p["position_id"]));
        bySymbol.set(sym, existing);
      }

      const denom = totalAum > 0 ? totalAum : 1;
      const actualEquityPct = round2((equityVal / denom) * 100);
      const actualFixedIncomePct = round2((fixedIncomeVal / denom) * 100);
      const actualCashPct = round2((cashVal / denom) * 100);
      const targetEquityPct = Number(hh["target_equity_pct"]);
      const targetFixedIncomePct = Number(hh["target_fixed_income_pct"]);
      const targetCashPct = Number(hh["target_cash_pct"]);

      const weightedYtdPct =
        totalAum > 0
          ? round2(
              acctRes.rows.reduce((s, a) => s + Number(a["market_value"] ?? 0) * Number(a["ytd_return_pct"] ?? 0), 0) /
                totalAum,
            )
          : 0;

      const holdings = [...bySymbol.values()]
        .sort((a, b) => b.market_value - a.market_value)
        .map((h) => ({
          ...h,
          weight_pct: round2((h.market_value / denom) * 100),
          unrealized_gain: round2(h.market_value - h.cost_basis),
        }));

      const flow = flowRes.rows[0]!;
      const contributions = round2(Number(flow["contributions"] ?? 0));
      const withdrawals = round2(Number(flow["withdrawals"] ?? 0));
      const custodians = [...new Set(acctRes.rows.map((a) => String(a["custodian"])))];

      const payload = {
        household_id: String(hh["household_id"]),
        household_name: String(hh["name"]),
        risk_profile: String(hh["risk_profile"]),
        last_review_date: String(hh["last_review_date"]),
        next_review_date: hh["next_review_date"] ? String(hh["next_review_date"]) : null,
        total_aum: totalAum,
        weighted_ytd_return_pct: weightedYtdPct,
        custodians,
        accounts: acctRes.rows.map((a) => ({
          row_id: String(a["account_id"]),
          account_id: String(a["account_id"]),
          custodian: String(a["custodian"]),
          account_type: String(a["account_type"]),
          market_value: round2(Number(a["market_value"] ?? 0)),
          cash_balance: round2(Number(a["cash_balance"] ?? 0)),
          ytd_return_pct: Number(a["ytd_return_pct"] ?? 0),
        })),
        allocation: {
          actual: {
            equity_pct: actualEquityPct,
            fixed_income_pct: actualFixedIncomePct,
            cash_pct: actualCashPct,
            equity_value: round2(equityVal),
            fixed_income_value: round2(fixedIncomeVal),
            cash_value: round2(cashVal),
          },
          target: {
            equity_pct: targetEquityPct,
            fixed_income_pct: targetFixedIncomePct,
            cash_pct: targetCashPct,
          },
          drift_pct: {
            equity: round2(actualEquityPct - targetEquityPct),
            fixed_income: round2(actualFixedIncomePct - targetFixedIncomePct),
            cash: round2(actualCashPct - targetCashPct),
          },
        },
        holdings,
        cash_flows_12m: {
          contributions,
          withdrawals,
          net_flows: round2(contributions + withdrawals),
          dividends: round2(Number(flow["dividends"] ?? 0)),
          transaction_count: Number(flow["txn_count"] ?? 0),
        },
        recent_meetings: notesRes.rows.map((n) => ({ row_id: String(n["note_id"]), ...n })),
        open_tasks: tasksRes.rows.map((t) => ({ row_id: String(t["task_id"]), ...t })),
      };

      const resultId = createResultId("review", payload);
      rememberComputedResult({
        resultId,
        kind: "query",
        sql: `-- Deterministic portfolio review for ${payload.household_id} (${payload.household_name}) across accounts, positions, and 12m transactions`,
        rows: holdings as unknown as Record<string, unknown>[],
        summary: {
          household: payload.household_name,
          total_aum: payload.total_aum,
          weighted_ytd_return_pct: payload.weighted_ytd_return_pct,
          actual_equity_pct: actualEquityPct,
          target_equity_pct: targetEquityPct,
          net_flows_12m: payload.cash_flows_12m.net_flows,
        },
      });

      return { result_id: resultId, ...payload };
    },
    { readOnly: true, role: process.env.DB_APP_ROLE, statementTimeoutMs: 5_000 },
  );
}

export async function searchNotesForAdvisor(
  pool: Pool,
  ctx: TenantContext,
  params: { query: string; clientId?: string; limit?: number },
): Promise<NoteSearchHit[]> {
  let householdId: string | undefined;
  if (params.clientId) {
    const resolved = await withTenantContext(
      pool,
      ctx,
      (client) => resolveHousehold(client, params.clientId!),
      { readOnly: true, role: process.env.DB_APP_ROLE, statementTimeoutMs: 5_000 },
    );
    if (!resolved) return [];
    householdId = resolved.householdId;
  }
  return searchAdvisorNotes(pool, ctx, { query: params.query, householdId, limit: params.limit });
}

export async function queryAdvisorWarehouse(pool: Pool, ctx: TenantContext, sqlInput: string) {
  const guard = guardPgSql(sqlInput);
  if (!guard.ok) {
    throw new Error(`Query rejected: ${guard.reason}`);
  }

  const rows = await withTenantContext(
    pool,
    ctx,
    async (client) => (await client.query(guard.sql!)).rows as Record<string, unknown>[],
    { readOnly: true, role: process.env.DB_RO_ROLE, statementTimeoutMs: 5_000 },
  );

  const limited = rows.slice(0, 200);
  const resultId = createResultId("pgquery", { sql: guard.sql, rows: limited });
  rememberComputedResult({
    resultId,
    kind: "query",
    sql: guard.sql!,
    rows: limited,
  });

  return {
    result_id: resultId,
    rows: limited,
    ...(rows.length === 0 ? { note: "Query returned 0 rows." } : {}),
  };
}

/** Resolves an advisor-mode cited record ID under RLS for the UI source drawer. */
export async function getAdvisorRowById(pool: Pool, ctx: TenantContext, rowId: string) {
  return withTenantContext(
    pool,
    ctx,
    async (client) => {
      if (rowId.startsWith("hh_")) {
        const r = (await client.query(`SELECT * FROM households WHERE household_id = $1 LIMIT 1`, [rowId])).rows[0];
        return r
          ? {
              kind: "source" as const,
              rowId,
              source: "household",
              eventTimestamp: r.updated_at ? String(r.updated_at) : null,
              summaryText: `${r.name} — ${r.risk_profile} profile · Address: ${r.address}`,
              payload: r,
            }
          : null;
      }
      if (rowId.startsWith("note_")) {
        const r = (
          await client.query(
            `SELECT note_id, household_id, meeting_date::text AS meeting_date, title, attendees, transcript
             FROM meeting_notes WHERE note_id = $1 LIMIT 1`,
            [rowId],
          )
        ).rows[0];
        return r
          ? {
              kind: "source" as const,
              rowId,
              source: "meeting_note",
              eventTimestamp: String(r.meeting_date),
              summaryText: `${r.title}\n\n${r.transcript}`,
              payload: r,
            }
          : null;
      }
      if (rowId.startsWith("email_")) {
        const r = (
          await client.query(
            `SELECT email_id, household_id, sent_at::text AS sent_at, direction, sender, recipient, subject, body
             FROM emails WHERE email_id = $1 LIMIT 1`,
            [rowId],
          )
        ).rows[0];
        return r
          ? {
              kind: "source" as const,
              rowId,
              source: "email",
              eventTimestamp: String(r.sent_at),
              summaryText: `${r.subject}\nFrom: ${r.sender} → To: ${r.recipient}\n\n${r.body}`,
              payload: r,
            }
          : null;
      }
      if (rowId.startsWith("acct_")) {
        const r = (await client.query(`SELECT * FROM accounts WHERE account_id = $1 LIMIT 1`, [rowId])).rows[0];
        return r
          ? {
              kind: "source" as const,
              rowId,
              source: "account",
              eventTimestamp: r.as_of_date ? String(r.as_of_date) : null,
              summaryText: `${r.custodian} ${r.account_type} (${r.account_number}) — Market value $${r.market_value}`,
              payload: r,
            }
          : null;
      }
      if (rowId.startsWith("txn_")) {
        const r = (await client.query(`SELECT * FROM transactions WHERE transaction_id = $1 LIMIT 1`, [rowId])).rows[0];
        return r
          ? {
              kind: "source" as const,
              rowId,
              source: "transaction",
              eventTimestamp: r.txn_date ? String(r.txn_date) : null,
              summaryText: `${r.txn_type} $${r.amount} (${r.custodian}) — ${r.description}`,
              payload: r,
            }
          : null;
      }
      if (rowId.startsWith("task_")) {
        const r = (await client.query(`SELECT * FROM tasks WHERE task_id = $1 LIMIT 1`, [rowId])).rows[0];
        return r
          ? {
              kind: "source" as const,
              rowId,
              source: "task",
              eventTimestamp: r.due_date ? String(r.due_date) : null,
              summaryText: `${r.title} (${r.status}, ${r.priority} priority)`,
              payload: r,
            }
          : null;
      }
      if (rowId.startsWith("prop_")) {
        const r = (await client.query(`SELECT * FROM proposals WHERE proposal_id = $1 LIMIT 1`, [rowId])).rows[0];
        return r
          ? {
              kind: "source" as const,
              rowId,
              source: "proposal",
              eventTimestamp: r.created_at ? String(r.created_at) : null,
              summaryText: `${r.kind} (${r.status}): ${r.summary}`,
              payload: r,
            }
          : null;
      }
      return null;
    },
    { readOnly: true, role: process.env.DB_APP_ROLE, statementTimeoutMs: 5_000 },
  );
}
