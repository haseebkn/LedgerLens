import { describe, expect, it } from "vitest";
import { guardPgSql } from "./sql-guard-pg.js";

describe("Postgres advisor SQL guard", () => {
  it("allows read-only SELECTs over allowlisted v_* views and appends a LIMIT", () => {
    const res = guardPgSql("SELECT household_id, name FROM v_households WHERE risk_profile = 'balanced'");
    expect(res.ok).toBe(true);
    expect(res.sql).toContain("LIMIT 200");
  });

  it("allows CTEs over allowlisted views and string literals containing banned keywords", () => {
    const res = guardPgSql(
      "WITH msft AS (SELECT household_id FROM v_positions WHERE symbol = 'MSFT') " +
        "SELECT h.name FROM v_households h JOIN msft m ON m.household_id = h.household_id " +
        "WHERE h.notes_summary ILIKE '%copy%' LIMIT 50",
    );
    expect(res.ok).toBe(true);
    expect(res.sql).not.toContain("LIMIT 200");
  });

  it("rejects raw base tables, system catalogs, and non-SELECT mutations", () => {
    expect(guardPgSql("SELECT * FROM households").ok).toBe(false);
    expect(guardPgSql("SELECT * FROM advisors").ok).toBe(false);
    expect(guardPgSql("SELECT * FROM pg_catalog.pg_tables").ok).toBe(false);
    expect(guardPgSql("SELECT pg_read_file('/etc/passwd') FROM v_households").ok).toBe(false);
    expect(guardPgSql("SELECT set_config('app.advisor_id', 'adv_marcus', true) FROM v_households").ok).toBe(false);
    expect(guardPgSql("DELETE FROM v_households").ok).toBe(false);
    expect(guardPgSql("SELECT * FROM v_households; DROP TABLE households").ok).toBe(false);
    expect(guardPgSql("SELECT * FROM v_households LIMIT 5000").ok).toBe(false);
  });
});
