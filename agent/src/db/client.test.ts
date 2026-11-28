import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenantContext } from "./client.js";

function makeFakePool() {
  const queries: { sql: string; params?: unknown[] }[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [] };
    }),
    release,
  } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, client, queries, release };
}

describe("withTenantContext", () => {
  it("sets transaction-local RLS context, optional role, and statement_timeout then commits", async () => {
    const { pool, queries, release } = makeFakePool();

    const out = await withTenantContext(
      pool,
      { firmId: "firm_atlantic_wealth", advisorId: "adv_sarah" },
      async (client) => {
        await client.query("SELECT * FROM households");
        return "ok";
      },
      { readOnly: true, role: "ledgerlens_ro", statementTimeoutMs: 5000 },
    );

    expect(out).toBe("ok");
    expect(queries.map((q) => q.sql)).toEqual([
      "BEGIN TRANSACTION READ ONLY",
      "SET LOCAL ROLE ledgerlens_ro",
      "SELECT set_config('app.firm_id', $1, true), set_config('app.advisor_id', $2, true)",
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT * FROM households",
      "COMMIT",
    ]);
    expect(queries[2]?.params).toEqual(["firm_atlantic_wealth", "adv_sarah"]);
    expect(queries[3]?.params).toEqual(["5000ms"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases the connection when the callback throws", async () => {
    const { pool, queries, release } = makeFakePool();

    await expect(
      withTenantContext(pool, { firmId: "firm_1", advisorId: "adv_1" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(queries.map((q) => q.sql)).toContain("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects empty tenant IDs and malformed Postgres role names", async () => {
    const { pool } = makeFakePool();
    await expect(withTenantContext(pool, { firmId: "", advisorId: "adv_1" }, async () => 1)).rejects.toThrow(/TenantContext/);
    await expect(
      withTenantContext(pool, { firmId: "firm_1", advisorId: "adv_1" }, async () => 1, { role: "bad; DROP TABLE households" }),
    ).rejects.toThrow(/Invalid Postgres role name/);
  });
});
