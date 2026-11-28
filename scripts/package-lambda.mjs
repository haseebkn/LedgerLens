// Stages the self-contained AWS Lambda deployment directory for the agent:
//
//   node scripts/package-lambda.mjs \
//     --warehouse financial_engine.db \
//     --node-modules /tmp/lambda-deps/node_modules \
//     --out /tmp/lambda-bundle
//
// Layout inside --out (becomes /var/task in Lambda):
//   package.json                (preserves "type": "module")
//   dist/                       (compiled agent JS, handler = dist/lambda.handler)
//   evals/reports/*.json|*.md   (public baseline reports only; never private/ or partial/)
//   data/financial_engine.db    (read-only synthetic DuckDB warehouse)
//   node_modules/               (production dependencies of agent/ only)

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    out[key.slice(2)] = value;
    i++;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(import.meta.dirname, "..");
const warehousePath = resolve(args.warehouse ?? join(repoRoot, "financial_engine.db"));
const nodeModulesPath = resolve(args["node-modules"] ?? join(repoRoot, "node_modules"));
const outDir = resolve(args.out ?? join(repoRoot, ".lambda-bundle"));

const agentDir = join(repoRoot, "agent");
const distDir = join(agentDir, "dist");
const pkgJson = join(agentDir, "package.json");
const reportsSrc = join(agentDir, "evals", "reports");

for (const [label, path] of [
  ["agent dist (run npm run build -w agent first)", distDir],
  ["agent package.json", pkgJson],
  ["warehouse database", warehousePath],
  ["node_modules", nodeModulesPath],
]) {
  if (!existsSync(path)) {
    console.error(`Missing ${label}: ${path}`);
    process.exit(1);
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "data"), { recursive: true });
mkdirSync(join(outDir, "evals", "reports"), { recursive: true });

cpSync(pkgJson, join(outDir, "package.json"));
cpSync(distDir, join(outDir, "dist"), { recursive: true });
cpSync(warehousePath, join(outDir, "data", "financial_engine.db"));
cpSync(nodeModulesPath, join(outDir, "node_modules"), { recursive: true });

// Copy only top-level public eval report files; exclude private/ and partial/.
if (existsSync(reportsSrc)) {
  for (const entry of readdirSync(reportsSrc, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".md"))) {
      cpSync(join(reportsSrc, entry.name), join(outDir, "evals", "reports", entry.name));
    }
  }
}

for (const required of [
  join(outDir, "dist", "lambda.js"),
  join(outDir, "data", "financial_engine.db"),
  join(outDir, "node_modules", "@duckdb", "node-api"),
]) {
  if (!existsSync(required)) {
    console.error(`Packaged Lambda bundle is missing ${required}`);
    process.exit(1);
  }
}

const dbMb = (statSync(join(outDir, "data", "financial_engine.db")).size / (1024 * 1024)).toFixed(2);
console.log(`Staged Lambda bundle at ${outDir} (warehouse ${dbMb} MiB)`);
