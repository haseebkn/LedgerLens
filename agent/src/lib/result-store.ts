/**
 * Bounded, in-process memory of computed tool results, so a cited
 * computed_* id can be opened in the UI's source drawer and show the exact
 * SQL and rows the model saw.
 *
 * Result ids are content hashes (lib/result-id.ts), so the same id always
 * refers to the same payload. Entries expire after an hour and the oldest
 * are evicted past MAX_ENTRIES; a restart forgets them, and the drawer then
 * says the result is no longer available. Once requests carry a signed-in
 * user (Phase 2.4), key entries by user as well.
 */

export interface ComputedResult {
  resultId: string;
  kind: "query" | "spend";
  sql: string;
  params?: (string | number | boolean | null)[];
  rows: Record<string, unknown>[];
  /** Extra fields the tool returned alongside the rows (totals, ranges). */
  summary?: Record<string, unknown>;
  createdAt: number;
}

const MAX_ENTRIES = 500;
const TTL_MS = 60 * 60 * 1000;
const store = new Map<string, ComputedResult>();

export function rememberComputedResult(entry: Omit<ComputedResult, "createdAt">, now = Date.now()): void {
  store.delete(entry.resultId); // re-insert to refresh recency
  store.set(entry.resultId, { ...entry, createdAt: now });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function getComputedResult(resultId: string, now = Date.now()): ComputedResult | undefined {
  const entry = store.get(resultId);
  if (!entry) return undefined;
  if (now - entry.createdAt > TTL_MS) {
    store.delete(resultId);
    return undefined;
  }
  return entry;
}

/** Test helper. */
export function clearComputedResults(): void {
  store.clear();
}
