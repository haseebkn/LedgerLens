import pkg from "node-sql-parser";
const { Parser } = pkg;

/**
 * Repair-guidance SQL guard for Postgres advisor mode (`query_warehouse`).
 * The real security boundary is Postgres itself: read-only role `ledgerlens_ro`,
 * `BEGIN TRANSACTION READ ONLY`, `statement_timeout`, and `security_invoker`
 * views enforcing Row-Level Security.
 */

const parser = new Parser();
const PARSE_OPTS = { database: "Postgresql" } as const;

export const ALLOWED_ADVISOR_VIEWS = new Set([
  "v_households",
  "v_household_members",
  "v_accounts",
  "v_positions",
  "v_transactions",
  "v_meeting_notes",
  "v_emails",
  "v_calendar_events",
  "v_tasks",
  "v_proposals",
  "v_audit_log",
]);

const BANNED_PG_PATTERN =
  /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_sleep|dblink|lo_import|lo_export|copy|set_config|current_setting|pg_catalog|information_schema)\w*/i;

const DEFAULT_ROW_LIMIT = 200;
const MAX_ROW_LIMIT = 1000;

export interface PgGuardResult {
  ok: boolean;
  sql?: string;
  reason?: string;
}

type AstNode = Record<string, unknown>;
function isNode(value: unknown): value is AstNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function blankStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

function inspectAst(value: unknown, outerCtes: ReadonlySet<string> = new Set()): string | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const reason = inspectAst(child, outerCtes);
      if (reason) return reason;
    }
    return;
  }
  if (!isNode(value)) return;

  const ctes = new Set(outerCtes);
  if (value.type === "select") {
    if (Array.isArray(value.with)) {
      for (const cte of value.with) {
        if (!isNode(cte) || !isNode(cte.name) || typeof cte.name.value !== "string") {
          return "Could not determine a CTE name.";
        }
        if (cte.recursive) return "Recursive CTEs are not permitted; use a bounded SELECT.";
        const reason = inspectAst(cte.stmt, ctes);
        if (reason) return reason;
        ctes.add(cte.name.value.toLowerCase());
      }
    }
    if (Array.isArray(value.from)) {
      for (const ref of value.from) {
        if (!isNode(ref)) return "Could not determine a referenced table.";
        if (typeof ref.table === "string") {
          const table = ref.table.toLowerCase();
          const schema = typeof ref.db === "string" ? ref.db.toLowerCase() : null;
          if (schema && schema !== "public") {
            return `Schema "${schema}" is not permitted. Query allowlisted views: ${[...ALLOWED_ADVISOR_VIEWS].join(", ")}.`;
          }
          if (!ctes.has(table) && !ALLOWED_ADVISOR_VIEWS.has(table)) {
            return `Table or view "${ref.table}" is not in the allowlist. Available views: ${[...ALLOWED_ADVISOR_VIEWS].join(", ")}.`;
          }
        } else if (!isNode(ref.expr) || !isNode(ref.expr.ast)) {
          return "Table functions in FROM are not permitted; query allowlisted views only.";
        }
      }
    }
    if (isNode(value.limit) && Array.isArray(value.limit.value)) {
      for (const bound of value.limit.value) {
        if (!isNode(bound) || bound.type !== "number" || !Number.isSafeInteger(bound.value) || Number(bound.value) < 0) {
          return "LIMIT and OFFSET must be non-negative integer literals.";
        }
        if (Number(bound.value) > MAX_ROW_LIMIT) {
          return `LIMIT ${bound.value} exceeds the maximum of ${MAX_ROW_LIMIT} rows.`;
        }
      }
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (value.type === "select" && key === "with") continue;
    const reason = inspectAst(child, ctes);
    if (reason) return reason;
  }
}

function hasExplicitLimit(stmt: AstNode): boolean {
  let last = stmt;
  while (isNode(last._next)) last = last._next;
  const limit = last.limit;
  if (!isNode(limit) || !Array.isArray(limit.value) || limit.value.length === 0) return false;
  return !(limit.seperator === "offset" && limit.value.length === 1);
}

export function guardPgSql(sqlInput: string): PgGuardResult {
  const sql = sqlInput.trim().replace(/;+\s*$/g, "");
  if (!sql) return { ok: false, reason: "SQL query cannot be empty." };

  if (BANNED_PG_PATTERN.test(blankStringLiterals(sql))) {
    return {
      ok: false,
      reason: "Query references a disallowed Postgres function or system catalog. Query allowlisted views only.",
    };
  }

  let statements;
  try {
    statements = parser.astify(sql, PARSE_OPTS);
  } catch (e) {
    return { ok: false, reason: `SQL failed to parse: ${(e as Error).message.split("\n")[0]}` };
  }

  const list = Array.isArray(statements) ? statements : [statements];
  if (list.length !== 1) return { ok: false, reason: "Only a single SELECT statement is permitted." };

  const stmt = list[0]!;
  if (stmt.type !== "select") {
    return { ok: false, reason: `Only read-only SELECT queries are permitted (got "${stmt.type}").` };
  }

  const astReason = inspectAst(stmt);
  if (astReason) return { ok: false, reason: astReason };

  const tableRefs = parser.tableList(sql, PARSE_OPTS).map((entry) => {
    const parts = entry.split("::");
    return (parts[2] ?? entry).toLowerCase();
  });
  const allowedRefs = tableRefs.filter((t) => ALLOWED_ADVISOR_VIEWS.has(t));
  if (allowedRefs.length === 0) {
    return {
      ok: false,
      reason: `Query must reference an allowlisted view: ${[...ALLOWED_ADVISOR_VIEWS].join(", ")}.`,
    };
  }

  const finalSql = hasExplicitLimit(stmt as unknown as AstNode) ? sql : `${sql}\nLIMIT ${DEFAULT_ROW_LIMIT}`;
  return { ok: true, sql: finalSql };
}
