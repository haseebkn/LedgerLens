/** Validate CLI arguments before loading credentials or starting paid requests. */
export function parseEvalArgs(argv: string[]) {
  let subset: number | undefined;
  let caseIds: string[] | undefined;
  let judgeN: number | undefined;
  let gate = false;
  let write = true;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--gate") { gate = true; continue; }
    if (flag === "--no-write") { write = false; continue; }
    if (!["--subset", "--cases", "--judge-n"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--cases") {
      caseIds = value.split(",").map((id) => id.trim());
      if (caseIds.some((id) => !id) || new Set(caseIds).size !== caseIds.length) throw new Error("--cases requires unique, non-empty case ids");
    } else {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1) throw new Error(`${flag} must be a positive integer`);
      if (flag === "--subset") subset = number;
      else judgeN = number;
    }
  }
  if (subset !== undefined && caseIds) throw new Error("Use either --subset or --cases, not both");
  return { subset, caseIds, judgeN, gate, write };
}
