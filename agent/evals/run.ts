import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadGoldenSet, type EvalReport } from "./types.js";
import { runEvalSuite } from "./runner.js";
import { buildReport, evaluateGate, formatReportMarkdown, hashGoldenSet, DEFAULT_THRESHOLDS } from "./report.js";
import { parseEvalArgs } from "./cli.js";
import { JUDGE_MODEL } from "./scorers/judge.js";
import { env } from "../src/config.js";
import { closePool, createPool } from "../src/db/client.js";

/**
 * CLI entrypoint. Usage:
 *   npx tsx evals/run.ts                             — personal suite (34 cases), judge n=3
 *   npx tsx evals/run.ts --suite advisor             — Phase 4 advisor suite (32 synthetic cases), judge n=3
 *   npx tsx evals/run.ts --suite advisor --category tenant_isolation,prompt_injection --gate
 *   npx tsx evals/run.ts --subset 12 --gate          — fast PR check, judge n=1
 *   npx tsx evals/run.ts --cases retrieval-05,aggregation-02 --judge-n 3 --no-write
 */

const EVALS_DIR = import.meta.dirname;
const REPORTS_DIR = join(EVALS_DIR, "reports");
const PRIVATE_REPORTS_DIR = join(REPORTS_DIR, "private");

async function main() {
  const { suite, subset, caseIds, categories, judgeN: requestedJudgeN, gate, write } = parseEvalArgs(process.argv.slice(2));

  const goldenFile = suite === "advisor" ? "advisor-golden.jsonl" : "golden.jsonl";
  const baselinePath = join(EVALS_DIR, suite === "advisor" ? "advisor-baseline.json" : "baseline.json");

  let cases = loadGoldenSet(join(EVALS_DIR, goldenFile));
  if (categories) {
    const allowed = new Set(categories);
    cases = cases.filter((goldenCase) => allowed.has(goldenCase.category));
    if (cases.length === 0) throw new Error(`No cases matched --category ${categories.join(",")}`);
  }
  if (subset) cases = cases.slice(0, subset);
  if (caseIds) {
    const requested = new Set(caseIds);
    cases = cases.filter((goldenCase) => requested.has(goldenCase.id));
    const missing = caseIds.filter((id) => !cases.some((goldenCase) => goldenCase.id === id));
    if (missing.length > 0) throw new Error(`Unknown case id(s): ${missing.join(", ")}`);
  }

  const advisorPool = suite === "advisor" ? (() => {
    if (!env.DATABASE_URL) {
      throw new Error("--suite advisor requires DATABASE_URL pointing to a seeded Postgres + pgvector database.");
    }
    return createPool(env.DATABASE_URL);
  })() : undefined;

  const judgeN = requestedJudgeN ?? (subset ? 1 : 3);
  console.log(`Running ${cases.length} ${suite} case(s) against ${env.AGENT_MODEL} (judge: ${JUDGE_MODEL}, n=${judgeN})...`);

  try {
    const results = await runEvalSuite(cases, { concurrency: 4, judgeN, advisorPool });
    const scope = subset !== undefined || caseIds !== undefined || categories !== undefined ? "partial" : "full";
    const report = buildReport(results, env.AGENT_MODEL, {
      goldenSetHash: hashGoldenSet(cases),
      scorerVersion: "3",
      judgeN,
      scope,
      costScope: "agent_only",
      latencyScope: "agent_only",
      suite,
      judgeModel: JUDGE_MODEL,
    });

    const timestamp = report.runAt.replace(/[:.]/g, "-");
    const baseline: EvalReport | undefined = existsSync(baselinePath)
      ? (JSON.parse(readFileSync(baselinePath, "utf-8")) as EvalReport)
      : undefined;

    const markdown = formatReportMarkdown(report, baseline);
    if (write) {
      const publicDir = scope === "partial" ? join(REPORTS_DIR, "partial") : REPORTS_DIR;
      mkdirSync(publicDir, { recursive: true });
      mkdirSync(PRIVATE_REPORTS_DIR, { recursive: true });
      writeFileSync(join(PRIVATE_REPORTS_DIR, `${timestamp}.json`), JSON.stringify(report, null, 2));

      const publicReport = {
        ...report,
        results: report.results.map(({ answerText: _answerText, seenRowIds: _seenRowIds, errorMessage: _error, ...result }) => result),
      };
      writeFileSync(join(publicDir, `${timestamp}.json`), JSON.stringify(publicReport, null, 2));
      const publicSummary = {
        ...report,
        results: report.results.map((result) => ({
          ...result,
          errorMessage: result.errored ? "See the private local report for error details." : undefined,
        })),
      };
      writeFileSync(join(publicDir, `${timestamp}.md`), formatReportMarkdown(publicSummary, baseline));
    }
    console.log(markdown);

    if (gate) {
      const result = evaluateGate(report, DEFAULT_THRESHOLDS, { baseline });
      if (!result.passed) {
        console.error("\nEVAL GATE FAILED:");
        for (const f of result.failures) console.error(`  - ${f}`);
        process.exit(1);
      }
      console.log("\nEval gate passed.");
    }
  } finally {
    if (advisorPool) await closePool(advisorPool);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
