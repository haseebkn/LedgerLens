import { Pool, type PoolClient, type PoolConfig } from "pg";

/**
 * Multi-tenant Postgres client with transaction-scoped Row-Level Security.
 *
 * Every tenant query runs inside a transaction that sets `app.firm_id` and
 * `app.advisor_id` via parameterized `set_config(..., true)` (local to that
 * transaction only, so pooled connections can never leak tenant context).
 *
 * When DB_APP_ROLE / DB_RO_ROLE are configured (e.g. Docker/CI running as the
 * `postgres` superuser), `SET LOCAL ROLE` drops superuser privileges for the
 * transaction so Postgres strictly enforces RLS policies and view-only grants.
 */

export interface TenantContext {
  firmId: string;
  advisorId: string;
}

export interface TenantQueryOptions {
  readOnly?: boolean;
  statementTimeoutMs?: number;
  role?: string;
}

const ROLE_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

let defaultPool: Pool | null = null;

export function createPool(connectionString: string, extra?: PoolConfig): Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...extra,
  });
}

export function getPool(): Pool {
  if (!defaultPool) {
    const url = process.env.DATABASE_URL?.trim();
    if (!url) {
      throw new Error("DATABASE_URL is required for Postgres advisor operations");
    }
    defaultPool = createPool(url);
  }
  return defaultPool;
}

export async function closePool(pool?: Pool): Promise<void> {
  const target = pool ?? defaultPool;
  if (!pool) defaultPool = null;
  if (target) await target.end();
}

/**
 * Runs `fn` inside a Postgres transaction scoped to `ctx.firmId` and
 * `ctx.advisorId` for Row-Level Security. Automatically rolls back on error.
 */
export async function withTenantContext<T>(
  pool: Pool,
  ctx: TenantContext,
  fn: (client: PoolClient) => Promise<T>,
  options: TenantQueryOptions = {},
): Promise<T> {
  if (!ctx.firmId.trim() || !ctx.advisorId.trim()) {
    throw new Error("TenantContext requires non-empty firmId and advisorId");
  }

  const role = options.role ?? (options.readOnly ? process.env.DB_RO_ROLE : process.env.DB_APP_ROLE);
  if (role && !ROLE_NAME_RE.test(role)) {
    throw new Error(`Invalid Postgres role name: ${role}`);
  }

  const client = await pool.connect();
  try {
    await client.query(options.readOnly ? "BEGIN TRANSACTION READ ONLY" : "BEGIN");
    if (role) {
      await client.query(`SET LOCAL ROLE ${role}`);
    }
    await client.query("SELECT set_config('app.firm_id', $1, true), set_config('app.advisor_id', $2, true)", [
      ctx.firmId,
      ctx.advisorId,
    ]);
    if (options.statementTimeoutMs && Number.isInteger(options.statementTimeoutMs) && options.statementTimeoutMs > 0) {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${options.statementTimeoutMs}ms`]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
