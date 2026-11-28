import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPORTS_DIR = join(import.meta.dirname, "..", "..", "evals", "reports");

/** Returns the most recently written eval report JSON, or null if none exist yet. */
export function getLatestEvalReport(reportsDir: string = REPORTS_DIR): unknown | null {
  if (!existsSync(reportsDir)) return null;

  const jsonFiles = readdirSync(reportsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);
  if (jsonFiles.length === 0) return null;

  // Filenames are ISO timestamps with `:`/`.` replaced by `-` (see evals/run.ts),
  // so a plain lexicographic sort is also chronological.
  jsonFiles.sort();
  for (const file of jsonFiles.reverse()) {
    try {
      const report: unknown = JSON.parse(readFileSync(join(reportsDir, file), "utf-8"));
      if (report && typeof report === "object" && !Array.isArray(report)) return report;
    } catch {
      // A concurrent writer or interrupted eval must not hide the previous
      // report. The next request will pick up the new file once complete.
    }
  }
  return null;
}
