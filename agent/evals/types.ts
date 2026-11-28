import { z } from "zod/v4";
import { readFileSync } from "node:fs";

export const LEGACY_CATEGORIES = ["retrieval", "aggregation", "multihop", "refusal", "nodata"] as const;

export const ADVISOR_CATEGORIES = [
  "client_lookup",
  "portfolio_review",
  "note_search",
  "proposal_governance",
  "tenant_isolation",
  "prompt_injection",
] as const;

export const ALL_CATEGORIES = [...LEGACY_CATEGORIES, ...ADVISOR_CATEGORIES] as const;

export const EvalCategorySchema = z.enum(ALL_CATEGORIES);
export type EvalCategory = z.infer<typeof EvalCategorySchema>;

export const ExpectedProposalSchema = z
  .object({
    kind: z.enum(["crm_update", "draft_follow_up", "create_task"]),
    min_count: z.number().int().positive().default(1),
    max_count: z.number().int().positive().optional(),
  })
  .strict();

export const GoldenCaseSchema = z
  .object({
    id: z.string().min(1),
    suite: z.enum(["personal", "advisor"]).optional(),
    category: EvalCategorySchema,
    advisor_id: z.string().min(1).optional(),
    question: z.string().min(1),
    expected_tools: z.array(z.string()),
    forbidden_tools: z.array(z.string()).optional(),
    expected_row_ids: z.array(z.string()),
    expected_row_id_prefixes: z.array(z.string().min(1)).optional(),
    expected_row_id_sets: z
      .array(
        z
          .object({
            any_of: z.array(z.string().min(1)).min(1),
            min_hits: z.number().int().positive(),
          })
          .strict()
          .refine((value) => value.min_hits <= value.any_of.length, "min_hits cannot exceed any_of length")
      )
      .optional(),
    forbidden_answer_substrings: z.array(z.string().min(1)).optional(),
    expected_proposals: z.array(ExpectedProposalSchema).optional(),
    forbid_proposals: z.boolean().optional(),
    rubric: z.string().min(1),
  })
  .strict();

export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

/** Loads and validates every case in a JSONL golden set. Throws on the first invalid line. */
export function loadGoldenSet(path: string): GoldenCase[] {
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  return lines.map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(`${path} line ${i + 1}: invalid JSON — ${(e as Error).message}`);
    }
    const result = GoldenCaseSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`${path} line ${i + 1}: ${result.error.issues.map((iss) => iss.message).join("; ")}`);
    }
    return result.data;
  });
}

export interface CreatedProposalSummary {
  proposalId: string;
  kind: "crm_update" | "draft_follow_up" | "create_task";
  householdId: string;
  summary?: string;
}

export interface CaseResult {
  id: string;
  category: EvalCategory;
  question: string;
  answerText: string;
  toolCalls: string[];
  seenRowIds: string[];
  errored: boolean;
  errorMessage?: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;

  toolChoiceScore: number; // 0 or 1
  recallScore: number; // 0..1
  judgeScore: number; // 1..5 (mean across n samples)
  judgeSpread: number; // max judge score - min judge score across samples
  judgeExplanation: string;
  citationsValid: boolean;

  // Phase 4 (Evals v2) deterministic grounding, safety & governance telemetry
  groundingScore?: number; // 0..1
  citationWarningCount?: number;
  fabricatedCitations?: string[];
  safetyScore?: number; // 0 or 1
  safetyViolations?: string[];
  createdProposals?: CreatedProposalSummary[];
  judgeCostUsd?: number;
  repaired?: boolean;
}

export interface EvalRunMetadata {
  /** Changes to case questions, expectations, or rubrics invalidate a baseline comparison. */
  goldenSetHash: string;
  scorerVersion: string;
  judgeN: number;
  scope: "full" | "partial";
  costScope: "agent_only";
  latencyScope: "agent_only";
  suite?: "personal" | "advisor";
  judgeModel?: string;
}

export interface CategoryStats {
  count: number;
  toolChoiceAccuracy: number;
  meanRecall: number;
  meanJudgeScore: number;
  meanJudgeSpread: number;
  meanGroundingScore?: number;
  safetyPassRate?: number;
}

export interface EvalReport {
  runAt: string;
  model: string;
  totalCases: number;
  metadata?: EvalRunMetadata;
  categoryBreakdown: Record<string, CategoryStats>;
  aggregate: {
    toolChoiceAccuracy: number;
    meanRecall: number;
    meanJudgeScore: number;
    meanJudgeSpread: number;
    maxJudgeSpread: number;
    totalCostUsd: number;
    p50DurationMs: number;
    p95DurationMs: number;
    meanGroundingScore?: number;
    safetyPassRate?: number;
    totalCitationWarnings?: number;
    totalJudgeCostUsd?: number;
  };
  results: CaseResult[];
}
