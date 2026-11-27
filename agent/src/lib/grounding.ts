/**
 * Numeric grounding: checks every dollar figure and record count in the
 * final answer against the evidence it cites, so "the answer is checked"
 * means the numbers, not only the citation ids.
 *
 * A figure is flagged when its sentence has no citation ("uncited"), or
 * when none of the cited rows or computed results contains that amount
 * ("not_in_source"). Flagged figures stream as citation_warning events and
 * the UI marks them "Unverified". The check is deliberately literal: a sum
 * the model did in its head (two cited amounts added together) is flagged,
 * because nothing it cites states that total.
 *
 * Counts are claims like "3 transactions" or "five Starbucks purchases":
 * a number (digits or one–twelve), up to two words, then a record noun. A
 * count passes when a cited record contains that number (e.g. a
 * summarize_spend group's count) or when the sentence cites exactly that
 * many distinct rows. Zero counts ("no transactions") are not checked.
 *
 * Not checked: percentages, dates, and counts of other nouns.
 */

const ROW_ID_PATTERN = /^(?:calendar|plaid|alpaca|computed)_[a-zA-Z0-9_-]+$/;
const CITATION_PATTERN = /\[([a-zA-Z0-9_-]+)\](?!\()/g;
// $1,234.56 · -$12 · $ 40.00 · $1.2k is not matched (no shorthand in answers).
const DOLLAR_PATTERN = /-?\$\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\$\s?\d+(?:\.\d+)?/g;
const NUMBER_IN_TEXT = /-?\d[\d,]*(?:\.\d+)?/g;
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const COUNT_PATTERN = new RegExp(
  String.raw`\b(\d{1,5}|${Object.keys(NUMBER_WORDS).join("|")})\s+(?:[A-Za-z'-]+\s+){0,2}?` +
    String.raw`(?:transactions?|purchases?|orders?|trades?|payments?|charges?|deposits?|withdrawals?|` +
    String.raw`events?|meetings?|appointments?|visits?)\b`,
  "gi",
);

export type Evidence = Map<string, Set<number>>;

export interface GroundingWarning {
  /** The figure exactly as written in the answer, e.g. "$1,234.56" or "3 transactions". */
  figure: string;
  kind: "amount" | "count";
  /** The sentence (or list item / table row) the figure appears in. */
  sentence: string;
  reason: "uncited" | "not_in_source";
  citedIds: string[];
}

function toNumber(raw: string): number | null {
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function numbersIn(value: unknown, out: Set<number>): void {
  if (typeof value === "number") {
    if (Number.isFinite(value)) out.add(value);
  } else if (typeof value === "string") {
    for (const m of value.matchAll(NUMBER_IN_TEXT)) {
      const n = toNumber(m[0]);
      if (n !== null) out.add(n);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v) => numbersIn(v, out));
  } else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((v) => numbersIn(v, out));
  }
}

function addEvidence(evidence: Evidence, id: string, numbers: Set<number>): void {
  const existing = evidence.get(id) ?? new Set<number>();
  numbers.forEach((n) => existing.add(n));
  evidence.set(id, existing);
}

/**
 * Maps each id in a successful tool result to the numbers it vouches for:
 * a result_id vouches for the whole result; a row_id for its own record;
 * a sample_row_ids entry for the group it was sampled from.
 */
export function extractEvidence(toolResultText: string, evidence: Evidence = new Map()): Evidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolResultText);
  } catch {
    return evidence;
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const scope = new Set<number>();
    numbersIn(record, scope);
    for (const key of ["row_id", "result_id"] as const) {
      const id = record[key];
      if (typeof id === "string" && ROW_ID_PATTERN.test(id)) {
        addEvidence(evidence, id, key === "result_id" ? allNumbers(parsed) : scope);
      }
    }
    const samples = record["sample_row_ids"];
    if (Array.isArray(samples)) {
      for (const id of samples) {
        if (typeof id === "string" && ROW_ID_PATTERN.test(id)) addEvidence(evidence, id, scope);
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(parsed);
  return evidence;
}

function allNumbers(value: unknown): Set<number> {
  const out = new Set<number>();
  numbersIn(value, out);
  return out;
}

/** Splits an answer into the units a reader treats as one claim. */
export function splitClaims(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => (/^\s*\|/.test(line) ? [line] : line.split(/(?<=[.!?])\s+(?=[A-Z*\-(])/)))
    .map((s) => s.trim())
    .filter(Boolean);
}

function matches(figure: number, candidates: Set<number>, wholeDollars: boolean): boolean {
  const target = Math.abs(figure);
  for (const raw of candidates) {
    const c = Math.abs(raw);
    if (Math.abs(c - target) < 0.005) return true;
    // "$1,235" written for 1234.56: allow rounding to whole dollars only
    // when the answer itself has no cents.
    if (wholeDollars && Math.round(c) === target) return true;
  }
  return false;
}

function countValue(token: string): number | null {
  const word = NUMBER_WORDS[token.toLowerCase()];
  if (word !== undefined) return word;
  const n = Number(token);
  return Number.isSafeInteger(n) ? n : null;
}

export function checkNumericGrounding(answerText: string, evidence: Evidence): GroundingWarning[] {
  const warnings: GroundingWarning[] = [];
  for (const sentence of splitClaims(answerText)) {
    const amounts = [...sentence.matchAll(DOLLAR_PATTERN)].map((m) => m[0]);
    const counts = [...sentence.matchAll(COUNT_PATTERN)]
      .map((m) => ({ figure: m[0], value: countValue(m[1]!) }))
      .filter((c): c is { figure: string; value: number } => c.value !== null && c.value > 0);
    if (amounts.length === 0 && counts.length === 0) continue;
    const citedIds = [...new Set([...sentence.matchAll(CITATION_PATTERN)].map((m) => m[1]!))];
    const pool = new Set<number>();
    for (const id of citedIds) evidence.get(id)?.forEach((n) => pool.add(n));
    const flag = (figure: string, kind: GroundingWarning["kind"], supported: boolean) => {
      if (citedIds.length === 0) warnings.push({ figure, kind, sentence, reason: "uncited", citedIds });
      else if (!supported) warnings.push({ figure, kind, sentence, reason: "not_in_source", citedIds });
    };
    for (const figure of amounts) {
      const value = toNumber(figure);
      if (value === null) continue;
      flag(figure, "amount", matches(value, pool, !figure.includes(".")));
    }
    for (const { figure, value } of counts) {
      flag(figure, "count", pool.has(value) || citedIds.length === value);
    }
  }
  return warnings;
}
