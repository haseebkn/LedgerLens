import { queryRowsParams } from "./duckdb.js";

/**
 * In-process search over main_analytics.fct_context_rows for serverless
 * deployments (RETRIEVAL_MODE=local), removing the 3 GiB Python + PyTorch
 * retrieval container from the serving path.
 *
 * Uses BM25 over tokenized, lightly stemmed summary_text and structured
 * payload fields, plus low-weight domain synonym expansion so natural
 * phrasing ("coffee", "hardware store", "rock climbing", "dentist") finds
 * the matching records deterministically with zero external dependencies.
 * Phase 3.4 replaces this with Postgres + pgvector.
 */

export interface ContextRow {
  row_id: string;
  summary_text: string;
  source: string;
  record_date: string;
  raw_payload?: string | Record<string, unknown> | null;
}

export interface LocalRetrievalResult {
  row_id: string;
  document: string;
  source: string;
  record_date: string;
  distance: number;
  similarity: number;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "from", "by", "is", "am", "are", "was", "were", "be", "been", "do",
  "did", "does", "have", "has", "had", "i", "me", "my", "we", "our", "you",
  "your", "it", "its", "this", "that", "these", "those", "what", "when",
  "where", "who", "which", "how", "about", "any", "some", "there", "go",
  "went", "get", "got", "recently", "recent", "latest", "last",
]);

/** Bidirectional financial/calendar synonym clusters for natural-language recall. */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["coffee", "cafe", "espresso", "latte", "starbucks", "hortons", "bakery", "baking"],
  ["grocery", "groceries", "supermarket", "sobeys", "costco", "market"],
  ["restaurant", "dining", "dinner", "lunch", "eat", "pizzeria", "mallard", "piatto"],
  ["hardware", "tools", "canadian", "tire"],
  ["climb", "climbing", "boulder", "bouldering", "gym", "fitness", "wallnut", "recreation"],
  ["ride", "rideshare", "taxi", "cab", "uber"],
  ["flight", "fly", "airline", "airport", "trip", "travel", "hotel", "lodging", "toronto", "yyt"],
  ["dentist", "dental", "teeth", "cleaning", "checkup"],
  ["doctor", "clinic", "medical", "health", "physical", "torbay"],
  ["rent", "housing", "apartment", "landlord", "harbourview", "property"],
  ["utility", "utilities", "electric", "electricity", "power", "newfoundland"],
  ["phone", "mobile", "cell", "telecom", "telecommunication", "bell"],
  ["subscription", "streaming", "netflix"],
  ["salary", "paycheck", "payday", "payroll", "income", "wage", "deposit", "atlantic"],
  ["stock", "stocks", "share", "shares", "trade", "trades", "brokerage", "invest", "order", "alpaca"],
  ["birthday", "party", "gift", "card"],
  ["meeting", "checkin", "manager", "weekly"],
];

const SYNONYM_MAP = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
  const stemmed = group.map(stem);
  for (const term of stemmed) {
    const set = SYNONYM_MAP.get(term) ?? new Set<string>();
    for (const peer of stemmed) {
      if (peer !== term) set.add(peer);
    }
    SYNONYM_MAP.set(term, set);
  }
}

export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4 && /(?:ch|sh|ss|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

export function tokenize(text: string, dropStopWords = true): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const filtered = dropStopWords ? raw.filter((t) => !STOP_WORDS.has(t)) : raw;
  const chosen = filtered.length > 0 ? filtered : raw;
  return chosen.map(stem);
}

function searchableText(row: ContextRow): string {
  const parts = [row.summary_text];
  if (row.raw_payload) {
    let payload: Record<string, unknown> | null = null;
    if (typeof row.raw_payload === "string") {
      try {
        const parsed: unknown = JSON.parse(row.raw_payload);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        // Ignore unparseable raw_payload; summary_text is still indexed.
      }
    } else if (typeof row.raw_payload === "object") {
      payload = row.raw_payload;
    }
    if (payload) {
      for (const key of ["name", "merchant_name", "category", "summary", "description", "location", "symbol"]) {
        const v = payload[key];
        if (typeof v === "string" && v.trim()) parts.push(v);
        else if (Array.isArray(v)) parts.push(v.map(String).join(" "));
      }
    }
  }
  return parts.join(" ");
}

/** Pure BM25 + synonym ranking over candidate warehouse rows. */
export function rankContextRows(rows: ContextRow[], query: string, limit: number): LocalRetrievalResult[] {
  if (rows.length === 0 || limit <= 0) return [];

  const queryTerms = tokenize(query, true);
  if (queryTerms.length === 0) return [];

  // Exact query terms get weight 1.0; expanded synonyms get 0.45 so literal matches always win.
  const termWeights = new Map<string, number>();
  for (const t of queryTerms) {
    termWeights.set(t, 1.0);
    const peers = SYNONYM_MAP.get(t);
    if (peers) {
      for (const peer of peers) {
        if (!termWeights.has(peer)) termWeights.set(peer, 0.45);
      }
    }
  }

  const docs = rows.map((row) => {
    const text = searchableText(row);
    const tokens = tokenize(text, false);
    const tf = new Map<string, number>();
    for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);
    return { row, lower: text.toLowerCase(), length: tokens.length, tf };
  });

  const N = docs.length;
  const avgLen = Math.max(1, docs.reduce((s, d) => s + d.length, 0) / N);
  const df = new Map<string, number>();
  for (const term of termWeights.keys()) {
    let count = 0;
    for (const doc of docs) {
      if (doc.tf.has(term)) count++;
    }
    df.set(term, count);
  }

  const k1 = 1.2;
  const b = 0.75;
  const needle = query.trim().toLowerCase();

  const scored: { row: ContextRow; score: number }[] = [];
  for (const doc of docs) {
    let score = 0;
    for (const [term, weight] of termWeights) {
      const freq = doc.tf.get(term) ?? 0;
      if (freq === 0) continue;
      const docFreq = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
      const tfNorm = (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (doc.length / avgLen)));
      score += weight * idf * tfNorm;
    }
    if (score > 0 && needle.length >= 3 && doc.lower.includes(needle)) {
      score *= 1.35;
    }
    if (score > 0) scored.push({ row: doc.row, score });
  }

  scored.sort((a, bDoc) => {
    if (Math.abs(bDoc.score - a.score) > 1e-6) return bDoc.score - a.score;
    return bDoc.row.record_date.localeCompare(a.row.record_date);
  });

  return scored.slice(0, limit).map(({ row, score }) => {
    const similarity = Math.min(0.999, score / (score + 2.0));
    return {
      row_id: row.row_id,
      document: row.summary_text,
      source: row.source,
      record_date: row.record_date,
      distance: 1 - similarity,
      similarity,
    };
  });
}

const ISO_DATE_OR_TS = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/;

function parseBound(value: string, label: string): { sqlValue: string; exclusiveEnd: boolean; ms: number } {
  if (!ISO_DATE_OR_TS.test(value)) {
    throw new Error(`Invalid date range: ${label} must be YYYY-MM-DD or YYYY-MM-DD HH:MM:SS without a timezone.`);
  }
  const dateOnly = value.length === 10;
  const iso = dateOnly ? `${value}T00:00:00Z` : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid date range: ${label} is not a valid calendar date.`);
  }
  return { sqlValue: value, exclusiveEnd: dateOnly, ms };
}

export async function searchLocalContext(params: {
  query: string;
  limit: number;
  source?: "calendar" | "plaid" | "alpaca";
  after?: string;
  before?: string;
}): Promise<LocalRetrievalResult[]> {
  const where: string[] = ["summary_text IS NOT NULL", "TRIM(summary_text) != ''"];
  const values: (string | number | boolean | null)[] = [];

  if (params.source) {
    values.push(params.source);
    where.push(`source = $${values.length}`);
  }

  const lower = params.after ? parseBound(params.after, "after") : null;
  const upper = params.before ? parseBound(params.before, "before") : null;
  if (lower && upper) {
    const upperMs = upper.exclusiveEnd ? upper.ms + 86_400_000 : upper.ms;
    if (lower.ms > upperMs || (upper.exclusiveEnd && lower.ms === upperMs)) {
      throw new Error("Invalid date range: after must not be later than before.");
    }
  }

  if (lower) {
    values.push(lower.sqlValue);
    where.push(`event_timestamp >= CAST($${values.length} AS TIMESTAMP)`);
  }
  if (upper) {
    values.push(upper.sqlValue);
    where.push(
      upper.exclusiveEnd
        ? `event_timestamp < CAST($${values.length} AS TIMESTAMP) + INTERVAL 1 DAY`
        : `event_timestamp <= CAST($${values.length} AS TIMESTAMP)`,
    );
  }

  const sql = `
    SELECT
      row_id,
      summary_text,
      source,
      CAST(event_timestamp AS VARCHAR) AS record_date,
      raw_payload
    FROM main_analytics.fct_context_rows
    WHERE ${where.join(" AND ")}
    ORDER BY event_timestamp DESC
    LIMIT 5000
  `;

  const rawRows = await queryRowsParams(sql, values);
  const candidates: ContextRow[] = rawRows.map((r) => ({
    row_id: String(r["row_id"]),
    summary_text: String(r["summary_text"]),
    source: String(r["source"]),
    record_date: String(r["record_date"] ?? ""),
    raw_payload: (r["raw_payload"] as string | Record<string, unknown> | null | undefined) ?? null,
  }));

  return rankContextRows(candidates, params.query, params.limit);
}
