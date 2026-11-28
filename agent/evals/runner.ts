import type { Pool } from "pg";
import { runAgentTurn } from "../src/agent-loop.js";
import type { TenantContext } from "../src/db/client.js";
import { env } from "../src/config.js";
import type { AgentStreamEvent } from "../src/streaming-types.js";
import type { CaseResult, CreatedProposalSummary, GoldenCase } from "./types.js";
import { scoreToolChoice } from "./scorers/tool-choice.js";
import { scoreRetrievalRecall } from "./scorers/retrieval-recall.js";
import { scoreGrounding } from "./scorers/grounding.js";
import { scoreSafety } from "./scorers/safety.js";
import { judgeWithSpread as realJudgeWithSpread, type JudgeEvidence } from "./scorers/judge.js";

export interface AdvisorEvalContext {
  pool: Pool;
  tenant: TenantContext;
}

export type AgentTurnFn = (params: {
  history: [];
  userMessage: string;
  advisorContext?: AdvisorEvalContext;
}) => AsyncGenerator<AgentStreamEvent>;

export type JudgeFn = (
  goldenCase: GoldenCase,
  answerText: string,
  n?: number,
  evidence?: JudgeEvidence,
) => Promise<{ meanScore: number; spread: number; citationsValid: boolean; explanation: string; judgeCostUsd?: number }>;

const OBSERVED_ROW_ID_RE = /\b((?:calendar|plaid|alpaca|computed|hh|acct|pos|txn|note|email|evt|task|prop)_[a-zA-Z0-9_-]+)\b/g;

export interface RunEvalOptions {
  judgeN?: number;
  agentTurn?: AgentTurnFn;
  judge?: JudgeFn;
  /** Optional Postgres pool + firm ID for live Phase 3/4 advisor-suite runs under RLS. */
  advisorPool?: Pool;
  firmId?: string;
}

/**
 * Runs one golden case through the agent loop and scores it across all Phase 4
 * axes: tool choice, retrieval recall, deterministic grounding & citation
 * precision, deterministic safety/governance/RLS invariants, and evidence-aware
 * LLM judge (mean + spread).
 */
export async function runEvalCase(
  goldenCase: GoldenCase,
  options: RunEvalOptions = {},
): Promise<CaseResult> {
  const agentTurn: AgentTurnFn = options.agentTurn ?? runAgentTurn;
  const judgeWithSpread: JudgeFn = options.judge ?? realJudgeWithSpread;
  const judgeN = options.judgeN ?? 3;
  if (!Number.isInteger(judgeN) || judgeN < 1) throw new Error("judgeN must be a positive integer");

  const toolCalls: string[] = [];
  const seenRowIds = new Set<string>();
  const createdProposals: CreatedProposalSummary[] = [];
  let citationWarningCount = 0;
  let answerText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let durationMs: number | undefined;
  let repaired = false;
  let completed = false;
  const startedAt = Date.now();

  const advisorContext: AdvisorEvalContext | undefined = options.advisorPool
    ? {
        pool: options.advisorPool,
        tenant: {
          firmId: options.firmId ?? "firm_atlantic_wealth",
          advisorId: goldenCase.advisor_id ?? env.DEFAULT_ADVISOR_ID,
        },
      }
    : undefined;

  try {
    turn: for await (const event of agentTurn({
      history: [],
      userMessage: goldenCase.question,
      ...(advisorContext ? { advisorContext } : {}),
    })) {
      switch (event.type) {
        case "tool_call":
          toolCalls.push(event.name);
          break;
        case "citation":
          seenRowIds.add(event.rowId);
          break;
        case "citation_warning":
          citationWarningCount += 1;
          break;
        case "proposal_created":
          seenRowIds.add(event.proposal.proposalId);
          createdProposals.push({
            proposalId: event.proposal.proposalId,
            kind: event.proposal.kind,
            householdId: event.proposal.householdId,
            summary: event.proposal.summary,
          });
          break;
        case "text_delta":
          answerText += event.text;
          break;
        case "text_correction":
          answerText = event.text;
          break;
        case "tool_result":
          if (event.isError) break;
          for (const match of event.summary.matchAll(OBSERVED_ROW_ID_RE)) {
            seenRowIds.add(match[1]!);
          }
          break;
        case "error":
          if (event.fatal) {
            return {
              id: goldenCase.id,
              category: goldenCase.category,
              question: goldenCase.question,
              answerText: "",
              toolCalls,
              seenRowIds: [...seenRowIds],
              errored: true,
              errorMessage: event.message,
              durationMs: Date.now() - startedAt,
              inputTokens,
              outputTokens,
              costUsd,
              toolChoiceScore: 0,
              recallScore: 0,
              judgeScore: 0,
              judgeSpread: 0,
              judgeExplanation: "Case errored before producing an answer.",
              citationsValid: false,
              groundingScore: 0,
              citationWarningCount,
              fabricatedCitations: [],
              safetyScore: 0,
              safetyViolations: ["Case errored before producing an answer."],
              createdProposals,
              repaired: false,
            };
          }
          break;
        case "done":
          inputTokens = event.usage.inputTokens;
          outputTokens = event.usage.outputTokens;
          costUsd = event.usage.estimatedCostUsd;
          durationMs = event.totalDurationMs;
          repaired = event.repaired;
          completed = true;
          break turn;
      }
    }
    if (!completed) throw new Error("Agent stream ended without a completion event.");
  } catch (e) {
    return {
      id: goldenCase.id,
      category: goldenCase.category,
      question: goldenCase.question,
      answerText,
      toolCalls,
      seenRowIds: [...seenRowIds],
      errored: true,
      errorMessage: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - startedAt,
      inputTokens,
      outputTokens,
      costUsd,
      toolChoiceScore: 0,
      recallScore: 0,
      judgeScore: 0,
      judgeSpread: 0,
      judgeExplanation: "Case threw before producing an answer.",
      citationsValid: false,
      groundingScore: 0,
      citationWarningCount,
      fabricatedCitations: [],
      safetyScore: 0,
      safetyViolations: ["Case threw before producing an answer."],
      createdProposals,
      repaired: false,
    };
  }

  const observedIds = [...seenRowIds];
  const toolChoiceScore = scoreToolChoice(goldenCase, toolCalls);
  const recallScore = scoreRetrievalRecall(goldenCase, observedIds);
  const grounding = scoreGrounding({ answerText, seenRowIds: observedIds, citationWarningCount });
  const safety = scoreSafety(goldenCase, { answerText, createdProposals });

  // The completion event measures the user-facing agent turn. Judge latency
  // belongs to the harness and must not inflate the advertised agent latency.
  const agentDurationMs = durationMs ?? Date.now() - startedAt;
  let judged: Awaited<ReturnType<JudgeFn>>;
  try {
    judged = await judgeWithSpread(goldenCase, answerText, judgeN, {
      toolCalls,
      seenRowIds: observedIds,
      createdProposals,
    });
  } catch (error) {
    return {
      id: goldenCase.id,
      category: goldenCase.category,
      question: goldenCase.question,
      answerText,
      toolCalls,
      seenRowIds: observedIds,
      errored: true,
      errorMessage: `Judge failed: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: agentDurationMs,
      inputTokens,
      outputTokens,
      costUsd,
      toolChoiceScore,
      recallScore,
      judgeScore: 0,
      judgeSpread: 0,
      judgeExplanation: "Judge failed; this case has no valid judge score.",
      citationsValid: false,
      groundingScore: grounding.groundingScore,
      citationWarningCount: grounding.citationWarningCount,
      fabricatedCitations: grounding.fabricatedCitations,
      safetyScore: safety.safetyScore,
      safetyViolations: safety.safetyViolations,
      createdProposals,
      repaired,
    };
  }

  return {
    id: goldenCase.id,
    category: goldenCase.category,
    question: goldenCase.question,
    answerText,
    toolCalls,
    seenRowIds: observedIds,
    errored: false,
    durationMs: agentDurationMs,
    inputTokens,
    outputTokens,
    costUsd,
    toolChoiceScore,
    recallScore,
    judgeScore: judged.meanScore,
    judgeSpread: judged.spread,
    judgeExplanation: judged.explanation,
    citationsValid: judged.citationsValid && grounding.fabricatedCitations.length === 0,
    groundingScore: grounding.groundingScore,
    citationWarningCount: grounding.citationWarningCount,
    fabricatedCitations: grounding.fabricatedCitations,
    safetyScore: safety.safetyScore,
    safetyViolations: safety.safetyViolations,
    createdProposals,
    ...(judged.judgeCostUsd !== undefined ? { judgeCostUsd: judged.judgeCostUsd } : {}),
    repaired,
  };
}

/** Runs a suite with bounded concurrency to avoid hammering rate limits. */
export async function runEvalSuite(
  cases: GoldenCase[],
  options: RunEvalOptions & { concurrency?: number } = {},
): Promise<CaseResult[]> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  const results: CaseResult[] = new Array(cases.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= cases.length) return;
      results[i] = await runEvalCase(cases[i]!, options);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  return results;
}

export { env };
