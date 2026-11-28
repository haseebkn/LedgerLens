import type { Pool } from "pg";
import type { TenantContext } from "../db/client.js";

export interface AdvisorSession extends TenantContext {
  advisorName: string;
  advisorEmail: string;
  firmName: string;
  isSynthetic: boolean;
}

const DEFAULT_ADVISOR_ID = "adv_sarah";

/**
 * Resolves a signed-in user's auth subject (or local/demo identity) to their
 * Postgres firm_id + advisor_id tenant context.
 */
export async function resolveAdvisorSession(
  pool: Pool,
  userId: string,
  fallbackAdvisorId: string = process.env.DEFAULT_ADVISOR_ID?.trim() || DEFAULT_ADVISOR_ID,
): Promise<AdvisorSession | null> {
  const res = await pool.query<{
    advisor_id: string;
    firm_id: string;
    advisor_name: string;
    advisor_email: string;
    firm_name: string;
    is_synthetic: boolean;
  }>(
    `SELECT a.advisor_id, a.firm_id, a.name AS advisor_name, a.email AS advisor_email,
            f.name AS firm_name, f.is_synthetic
     FROM advisors a
     JOIN firms f ON f.firm_id = a.firm_id
     WHERE a.auth_subject = $1 OR a.advisor_id = $1
     LIMIT 1`,
    [userId],
  );

  let row = res.rows[0];
  if (!row && (userId === "local-user" || userId === "demo")) {
    const fb = await pool.query<{
      advisor_id: string;
      firm_id: string;
      advisor_name: string;
      advisor_email: string;
      firm_name: string;
      is_synthetic: boolean;
    }>(
      `SELECT a.advisor_id, a.firm_id, a.name AS advisor_name, a.email AS advisor_email,
              f.name AS firm_name, f.is_synthetic
       FROM advisors a
       JOIN firms f ON f.firm_id = a.firm_id
       WHERE a.advisor_id = $1
       LIMIT 1`,
      [fallbackAdvisorId],
    );
    row = fb.rows[0];
  }

  if (!row) return null;
  return {
    firmId: row.firm_id,
    advisorId: row.advisor_id,
    advisorName: row.advisor_name,
    advisorEmail: row.advisor_email,
    firmName: row.firm_name,
    isSynthetic: row.is_synthetic,
  };
}
