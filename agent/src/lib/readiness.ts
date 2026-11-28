import { env } from "../config.js";
import { queryRows } from "./duckdb.js";

/**
 * Deep readiness: can this task actually answer a question? Used by the
 * deploy smoke test and by operators, never as the load balancer's health
 * check. The ALB checks /health, which does no I/O, so a slow warehouse or
 * a restarting retrieval service can't make ECS kill a healthy agent task.
 */

export type CheckResult = "ok" | "failed";

export interface Readiness {
  ready: boolean;
  checks: { warehouse: CheckResult; retrieval: CheckResult };
}

const TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function checkWarehouse(): Promise<CheckResult> {
  try {
    await withTimeout(queryRows("SELECT row_id FROM main_analytics.fct_context_rows LIMIT 1"), TIMEOUT_MS);
    return "ok";
  } catch (e) {
    console.error("Readiness: warehouse check failed:", e);
    return "failed";
  }
}

export async function checkRetrieval(fetchImpl: typeof fetch = fetch): Promise<CheckResult> {
  if (env.RETRIEVAL_MODE === "local") {
    // In-process search reads directly from the warehouse's context mart.
    return checkWarehouse();
  }
  try {
    const response = await fetchImpl(new URL("/health", env.RETRIEVAL_SERVICE_URL), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return "ok";
    console.error(`Readiness: retrieval /health returned ${response.status}`);
    return "failed";
  } catch (e) {
    console.error("Readiness: retrieval check failed:", e);
    return "failed";
  }
}

export async function checkReadiness(): Promise<Readiness> {
  const [warehouse, retrieval] = await Promise.all([checkWarehouse(), checkRetrieval()]);
  return { ready: warehouse === "ok" && retrieval === "ok", checks: { warehouse, retrieval } };
}
