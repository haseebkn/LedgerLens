import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadGoldenSet, type EvalReport } from "./types.js";
import { runEvalSuite } from "./runner.js";
import { buildReport, evaluateGate, formatReportMarkdown, hashGoldenSet, DEFAULT_THRESHOLDS } from "./report.js";
import { parseEvalArgs } from "./cli.js";
import { env } from "../src/config.js";

/**
 * CLI entrypoint. Usage:
 *   npx tsx evals/run.ts               — full suite, n=3 judge samples
 *   npx tsx evals/run.ts --subset 12   — first 12 cases, n=1 judge sample (fast PR check)
 *   npx tsx evals/run.ts --cases retrieval-05,aggregation-02 --judge-n 3 --no-write
 *   npx tsx evals/run.ts --gate        — exit 1 if thresholds aren't met (for CI)
 */

const EVALS_DIR = import.meta.dirname;
const REPORTS_DIR = join(EVALS_DIR, "reports");
const PRIVATE_REPORTS_DIR = join(REPORTS_DIR, "private");
const BASELINE_PATH = join(EVALS_DIR, "baseline.json");

async function main() {
  const { subset, caseIds, judgeN: requestedJudgeN, gate, write } = parseEvalArgs(process.argv.slice(2));

  let cases = loadGoldenSet(join(EVALS_DIR, "golden.jsonl"));
  if (subset) cases = cases.slice(0, subset);
  if (caseIds) {
    const requested = new Set(caseIds);
    cases = cases.filter((goldenCase) => requested.has(goldenCase.id));
    const missing = caseIds.filter((id) => !cases.some((goldenCase) => goldenCase.id === id));
    if (missing.length > 0) throw new Error(`Unknown case id(s): ${missing.join(", ")}`);
  }

  const judgeN = requestedJudgeN ?? (subset ? 1 : 3);
  console.log(`Running ${cases.length} case(s) against ${env.AGENT_MODEL}, judge n=${judgeN}...`);

  const results = await runEvalSuite(cases, { concurrency: 4, judgeN });
  const scope = subset !== undefined || caseIds !== undefined ? "partial" : "full";
  const report = buildReport(results, env.AGENT_MODEL, {
    goldenSetHash: hashGoldenSet(cases),
    scorerVersion: "2",
    judgeN,
    scope,
    costScope: "agent_only",
    latencyScope: "agent_only",
  });

  // Create output directories at write time; private/ and partial/ may not
  // exist in a fresh clone.
  const timestamp = report.runAt.replace(/[:.]/g, "-");

  const baseline: EvalReport | undefined = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as EvalReport)
    : undefined;

  const markdown = formatReportMarkdown(report, baseline);
  if (write) {
    const publicDir = scope === "partial" ? join(REPORTS_DIR, "partial") : REPORTS_DIR;
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(PRIVATE_REPORTS_DIR, { recursive: true });
    writeFileSync(join(PRIVATE_REPORTS_DIR, `${timestamp}.json`), JSON.stringify(report, null, 2));

    // The full local report keeps answers and retrieved row ids for debugging.
    // The committed/UI artifact omits those personal-data-bearing fields while
    // retaining questions, scores, judge explanations, latency, and cost.
    const publicReport = {
      ...report,
      results: report.results.map(({ answerText: _answerText, seenRowIds: _seenRowIds, errorMessage: _error, ...result }) => result),
    };
    writeFileSync(join(publicDir, `${timestamp}.json`), JSON.stringify(publicReport, null, 2));
    const publicSummary = {
      ...report,
      results: report.results.map((result) => ({ ...result, errorMessage: result.errored ? "See the private local report for error details." : undefined })),
    };
    writeFileSync(join(publicDir, `${timestamp}.md`), formatReportMarkdown(publicSummary, baseline));
  }
  console.log(markdown);

  if (gate) {
    const result = evaluateGate(report, DEFAULT_THRESHOLDS);
    if (!result.passed) {
      console.error("\nEVAL GATE FAILED:");
      for (const f of result.failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log("\nEval gate passed.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
