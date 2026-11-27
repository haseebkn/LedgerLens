import pkg from "node-sql-parser";
const { Parser } = pkg;

/**
 * Validates SQL before it reaches DuckDB and turns mistakes into repair
 * guidance the model can act on. This is a helpful error layer, NOT the
 * security boundary: the engine itself is sandboxed in lib/duckdb.ts
 * (READ_ONLY, enable_external_access=false, locked configuration), which is
 * what stops file/HTTP reads even if a query slips past these checks — e.g.
 * a query() call whose target SQL is assembled from split strings.
 */

const parser = new Parser();
const PARSE_OPTS = { database: "Postgresql" } as const;

/** Every table the agent is allowed to query, schema-qualified. */
const ALLOWED_TABLES = new Set(
  [
    "main_staging.stg_alpaca_orders",
    "main_staging.stg_calendar_events",
    "main_staging.stg_plaid_transactions",
    "main_intermediate.int_calendar_events",
    "main_intermediate.int_plaid_transactions",
    "main_analytics.fct_context_rows",
    "main_analytics.dim_account_snapshot",
  ].map((t) => t.toLowerCase())
);

/**
 * Case-insensitive, word-boundary scan for DuckDB functions/statements that
 * can read or affect the filesystem or extension state. Table-function
 * calls like `read_csv_auto(...)` don't appear in node-sql-parser's
 * tableList() output at all (verified empirically), so the table allowlist
 * alone cannot catch them — this regex layer is load-bearing, not optional.
 */
const BANNED_PATTERN =
  /\b(read_csv|read_json|read_parquet|read_ndjson|read_text|read_blob|glob|sniff_csv|pragma|attach|detach|install|load|copy|export|import|httpfs|iceberg_scan|delta_scan|postgres_scan|postgres_attach|mysql_scan|mysql_attach|sqlite_scan|sqlite_attach|url|http_get)\w*/i;

const DEFAULT_ROW_LIMIT = 500;
const MAX_ROW_LIMIT = 2000;

export interface GuardResult {
  ok: boolean;
  /** The (possibly LIMIT-appended) SQL to actually run, when ok=true. */
  sql?: string;
  /** Human-readable reason, when ok=false — fed back to the model for a repair attempt. */
  reason?: string;
}

function extractTableRefs(sql: string): string[] {
  const raw = parser.tableList(sql, PARSE_OPTS);
  // node-sql-parser returns entries like "select::main_analytics::fct_context_rows"
  // or "select::null::x" for a CTE alias with no schema.
  return raw.map((entry) => {
    const parts = entry.split("::");
    const schema = parts[1];
    const table = parts[2] ?? entry;
    return schema && schema !== "null" ? `${schema}.${table}`.toLowerCase() : table.toLowerCase();
  });
}

type AstNode = Record<string, unknown>;

function isNode(value: unknown): value is AstNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate every SELECT in its own CTE scope, including subqueries and UNION branches. */
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
        if (cte.recursive) return "Recursive CTEs are not permitted; use a bounded warehouse SELECT.";
        // A non-recursive definition can see earlier CTEs, but not itself
        // or later siblings. DuckDB may bind those names to physical tables.
        const reason = inspectAst(cte.stmt, ctes);
        if (reason) return reason;
        ctes.add(cte.name.value.toLowerCase());
      }
    }
    if (Array.isArray(value.from)) {
      for (const ref of value.from) {
        if (!isNode(ref)) return "Could not determine a referenced table.";
        if (typeof ref.table === "string") {
          if (!ref.db && !ctes.has(ref.table.toLowerCase())) {
            return `Query references table(s) not in the allowed set: ${ref.table}. Use a schema-qualified warehouse table or a declared CTE.`;
          }
        } else if (!isNode(ref.expr) || !isNode(ref.expr.ast)) {
          // query(), query_table(), and catalog table functions do not appear
          // in tableList(). Reject table functions instead of guessing their targets.
          return "Query references a disallowed function in FROM. Only warehouse tables and SELECT subqueries are permitted.";
        }
      }
    }
    if (isNode(value.limit) && Array.isArray(value.limit.value)) {
      for (const bound of value.limit.value) {
        if (!isNode(bound) || bound.type !== "number" || !Number.isSafeInteger(bound.value) || Number(bound.value) < 0) {
          return "LIMIT and OFFSET must be non-negative integer literals; unbounded or calculated limits are not permitted.";
        }
        if (Number(bound.value) > MAX_ROW_LIMIT) {
          return `LIMIT or OFFSET ${bound.value} exceeds the maximum of ${MAX_ROW_LIMIT} rows. Lower the bound or aggregate instead.`;
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
  // node-sql-parser attaches a compound query's final LIMIT to its last branch.
  let last = stmt;
  while (isNode(last._next)) last = last._next;
  const limit = last.limit;
  if (!isNode(limit) || !Array.isArray(limit.value) || limit.value.length === 0) return false;
  return !(limit.seperator === "offset" && limit.value.length === 1);
}

/**
 * Blanks string literals so the function blocklist only sees SQL, not data.
 * Without this, a search for '%installment%', '%global%' or '%important%'
 * was rejected as if it called install/glob/import. Calls such as
 * read_text('x') are still caught: the function name is outside the quotes.
 */
export function blankStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

export function guardSql(sqlInput: string): GuardResult {
  const sql = sqlInput.trim().replace(/;+\s*$/g, ""); // tolerate one trailing semicolon

  if (BANNED_PATTERN.test(blankStringLiterals(sql))) {
    return {
      ok: false,
      reason:
        "Query references a disallowed function or statement (file I/O, extension management, or attach/detach). " +
        "Only SELECT queries against the warehouse's own tables are permitted.",
    };
  }

  let statements;
  try {
    statements = parser.astify(sql, PARSE_OPTS);
  } catch (e) {
    return { ok: false, reason: `SQL failed to parse: ${(e as Error).message.split("\n")[0]}` };
  }

  const statementArray = Array.isArray(statements) ? statements : [statements];
  if (statementArray.length !== 1) {
    return { ok: false, reason: "Only a single SQL statement is permitted (no statement chaining)." };
  }

  const stmt = statementArray[0]!;
  if (stmt.type !== "select") {
    return {
      ok: false,
      reason: `Only SELECT queries are permitted (got "${stmt.type}"). This tool is read-only.`,
    };
  }

  const astReason = inspectAst(stmt);
  if (astReason) return { ok: false, reason: astReason };

  let tableRefs: string[];
  try {
    tableRefs = extractTableRefs(sql);
  } catch (e) {
    return { ok: false, reason: `Could not determine referenced tables: ${(e as Error).message.split("\n")[0]}` };
  }

  // inspectAst has already verified that each unqualified reference resolves
  // to a CTE in that SELECT's scope. Check the remaining physical tables here.
  const realTableRefs = tableRefs.filter((t) => t.includes("."));
  if (realTableRefs.length === 0) {
    return {
      ok: false,
      reason:
        "Query does not reference any warehouse table. " +
        `Available tables: ${[...ALLOWED_TABLES].join(", ")}.`,
    };
  }
  const disallowed = realTableRefs.filter((t) => !ALLOWED_TABLES.has(t));
  if (disallowed.length > 0) {
    return {
      ok: false,
      reason:
        `Query references table(s) not in the allowed set: ${disallowed.join(", ")}. ` +
        `Available tables: ${[...ALLOWED_TABLES].join(", ")}.`,
    };
  }

  const hasLimit = hasExplicitLimit(stmt as unknown as AstNode);
  let finalSql = sql;
  if (!hasLimit) {
    // Append on a NEW LINE, not with a space. A query ending in a `--`
    // comment ("SELECT ... -- note") would otherwise swallow the clause
    // entirely — "... -- note LIMIT 500" parses as a comment, DuckDB runs
    // the query uncapped, and the row limit is silently not enforced.
    // Verified against the real warehouse: a self-join that should have
    // returned 500 rows returned 8836. A line comment ends at the newline,
    // so this placement keeps the LIMIT outside it in every case.
    finalSql = `${sql}\nLIMIT ${DEFAULT_ROW_LIMIT}`;
  }

  return { ok: true, sql: finalSql };
}
