import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { env } from "../../src/config.js";
import { estimateCostUsd } from "../../src/lib/usage.js";
import type { CreatedProposalSummary, GoldenCase } from "../types.js";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL });

export const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL?.trim() || env.AGENT_MODEL;

export const JUDGE_SYSTEM_PROMPT =
  "You are grading an AI financial assistant's answer against a case-specific rubric. The rubric is the sole " +
  "contract: grade whether the answer actually delivers every outcome it requires. Do not reward caution, a " +
  "clarifying question, a refusal, or an offer to answer later when the rubric requires factual results or " +
  "calculated totals; an answer that provides none of the required result should score 1. Only reward a refusal " +
  "when the rubric itself requires or permits declining. Do not invent requirements absent from the rubric. Be " +
  "strict about fabricated facts and citations: a cited row_id must appear in the retrieved evidence (when " +
  "provided) and support the claim attached to it.";

const JUDGE_TOOL = {
  name: "submit_judgment",
  description: "Submit your evaluation of the assistant's answer.",
  input_schema: {
    type: "object" as const,
    properties: {
      score: {
        type: "integer" as const,
        minimum: 1,
        maximum: 5,
        description: "1 = fails the rubric outright, 5 = fully satisfies it.",
      },
      citations_valid: {
        type: "boolean" as const,
        description: "True if every factual claim is properly cited and no citation is fabricated or misattributed.",
      },
      explanation: {
        type: "string" as const,
        description: "One or two sentences justifying the score, referencing the rubric.",
      },
    },
    required: ["score", "citations_valid", "explanation"],
    additionalProperties: false,
  },
};

export interface JudgeResult {
  score: number;
  citationsValid: boolean;
  explanation: string;
  costUsd?: number;
}

export interface JudgeEvidence {
  toolCalls?: string[];
  seenRowIds?: string[];
  createdProposals?: CreatedProposalSummary[];
}

const JudgmentSchema = z.object({
  score: z.number().int().min(1).max(5),
  citations_valid: z.boolean(),
  explanation: z.string().min(1),
}).strict();

export function parseJudgment(input: unknown): JudgeResult {
  const validated = JudgmentSchema.parse(input);
  return { score: validated.score, citationsValid: validated.citations_valid, explanation: validated.explanation };
}

function formatEvidenceBlock(evidence?: JudgeEvidence): string {
  if (!evidence) return "";
  const lines: string[] = ["Observed turn evidence:"];
  if (evidence.toolCalls) {
    lines.push(`- Tools called: ${evidence.toolCalls.length > 0 ? evidence.toolCalls.join(", ") : "(none)"}`);
  }
  if (evidence.seenRowIds) {
    const sample = evidence.seenRowIds.slice(0, 40);
    lines.push(
      `- Observed row/result IDs (${evidence.seenRowIds.length}): ${sample.length > 0 ? sample.join(", ") : "(none)"}`,
    );
  }
  if (evidence.createdProposals && evidence.createdProposals.length > 0) {
    lines.push(
      `- Pending proposals created: ${evidence.createdProposals.map((p) => `${p.kind} for ${p.householdId} (${p.proposalId})`).join("; ")}`,
    );
  }
  return `\n\n${lines.join("\n")}`;
}

/** Scores one answer against its case's rubric using Claude as judge, forced into structured output via tool_choice. */
export async function judgeSingle(
  goldenCase: GoldenCase,
  answerText: string,
  evidence?: JudgeEvidence,
): Promise<JudgeResult> {
  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1024,
    system: JUDGE_SYSTEM_PROMPT,
    tools: [JUDGE_TOOL],
    tool_choice: { type: "tool", name: "submit_judgment" },
    messages: [
      {
        role: "user",
        content:
          `Question: ${goldenCase.question}\n\n` +
          `Rubric: ${goldenCase.rubric}` +
          formatEvidenceBlock(evidence) +
          `\n\nAssistant's answer:\n${answerText || "(empty — the assistant produced no text response)"}`,
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use" && b.name === "submit_judgment");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Judge did not return a tool_use block — cannot extract a structured score.");
  }
  const parsed = parseJudgment(toolUse.input);
  const costUsd = estimateCostUsd(
    {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    JUDGE_MODEL,
  );
  return { ...parsed, costUsd };
}

/**
 * Runs the judge n times and averages the score, since a single LLM-judge
 * sample is noise dressed as a metric. Returns the mean score, the spread
 * (max - min) so callers can see how much the judge disagreed with itself,
 * total judge cost (tracked separately from agent cost), and the explanation
 * from the run closest to the mean.
 */
export async function judgeWithSpread(
  goldenCase: GoldenCase,
  answerText: string,
  n = 3,
  evidence?: JudgeEvidence,
): Promise<{ meanScore: number; spread: number; citationsValid: boolean; explanation: string; judgeCostUsd?: number }> {
  if (!Number.isInteger(n) || n < 1) throw new Error("Judge sample count must be a positive integer");
  const runs = await Promise.all(Array.from({ length: n }, () => judgeSingle(goldenCase, answerText, evidence)));
  const scores = runs.map((r) => r.score);
  const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const spread = Math.max(...scores) - Math.min(...scores);
  const closest = runs.reduce((best, r) => (Math.abs(r.score - meanScore) < Math.abs(best.score - meanScore) ? r : best));
  // citations_valid is treated as unanimous-required: if any run flagged a
  // citation problem, surface it — false negatives here are worse than
  // false positives for a hallucination check.
  const citationsValid = runs.every((r) => r.citationsValid);
  const judgeCostUsd = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  return { meanScore, spread, citationsValid, explanation: closest.explanation, judgeCostUsd };
}
