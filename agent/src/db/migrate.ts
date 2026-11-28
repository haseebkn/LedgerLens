import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";

const DEFAULT_MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

/**
 * Applies SQL migrations from agent/src/db/migrations/ in lexical order,
 * tracking applied filenames in `schema_migrations` so re-runs are idempotent.
 */
export async function runMigrations(pool: Pool, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const appliedRes = await pool.query<{ version: string }>("SELECT version FROM schema_migrations");
  const alreadyApplied = new Set(appliedRes.rows.map((r) => r.version));

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (alreadyApplied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      newlyApplied.push(file);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}
