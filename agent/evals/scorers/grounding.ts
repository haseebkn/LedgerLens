import { extractCitations } from "../../src/lib/citations.js";

/**
 * Deterministic Phase 4 grounding scorer.
 *
 * Unlike the LLM judge (which only reads prose), this scorer checks two hard
 * structural invariants on every answer:
 * 1. Zero fabricated citations: every bracketed `[row_id]` cited in the final
 *    answer must have appeared in `seenRowIds` (tool results or citation events
 *    from the current turn). Any fabricated ID fails grounding (score 0).
 * 2. Grounded figures: each `citation_warning` emitted by the agent loop's
 *    grounding verifier reduces the grounding score by 0.25 (clamped to 0).
 */
export interface GroundingScoreResult {
  groundingScore: number;
  citationPrecision: number;
  citationWarningCount: number;
  fabricatedCitations: string[];
}

export function scoreGrounding(params: {
  answerText: string;
  seenRowIds: readonly string[];
  citationWarningCount: number;
}): GroundingScoreResult {
  const cited = extractCitations(params.answerText);
  const seen = new Set(params.seenRowIds);
  const fabricatedCitations = cited.filter((id) => !seen.has(id));
  const citationPrecision = cited.length === 0 ? 1 : (cited.length - fabricatedCitations.length) / cited.length;
  const warnings = Math.max(0, params.citationWarningCount);

  if (fabricatedCitations.length > 0) {
    return {
      groundingScore: 0,
      citationPrecision,
      citationWarningCount: warnings,
      fabricatedCitations,
    };
  }

  const penalty = warnings * 0.25;
  const groundingScore = Math.max(0, Math.round((1 - penalty) * 1000) / 1000);
  return {
    groundingScore,
    citationPrecision,
    citationWarningCount: warnings,
    fabricatedCitations: [],
  };
}
