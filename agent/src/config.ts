import { z } from "zod";

/**
 * Fail-fast environment schema. The process refuses to boot rather than
 * running with a missing credential or a silently-wrong default — the
 * TypeScript mirror of config/settings.py on the Python side.
 */
const EnvSchema = z.object({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().max(65535).default(8787),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required to run the agent loop"),
  AGENT_MODEL: z.string().default("claude-sonnet-5"),
  // Optional override of the Anthropic API endpoint, for the CI smoke test's
  // fake model server. Empty means "not set", never "use an empty URL".
  ANTHROPIC_BASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),

  // The single user's local zone, used to resolve "today", "last month",
  // and similar relative dates in each request.
  USER_TIME_ZONE: z
    .string()
    .default("America/St_Johns")
    .refine(
      (zone) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
          return true;
        } catch {
          return false;
        }
      },
      { message: "USER_TIME_ZONE must be a valid IANA time zone" }
    ),

  // Path to the DuckDB warehouse file, relative to the repo root.
  DUCKDB_PATH: z.string().default("../financial_engine.db"),

  // The internal retrieval service (Python/FastAPI, vector_prep/retrieval_service.py).
  RETRIEVAL_SERVICE_URL: z.string().url().default("http://127.0.0.1:8100"),
  RETRIEVAL_SERVICE_TOKEN: z.string().min(1, "RETRIEVAL_SERVICE_TOKEN is required to call the retrieval service"),

  // Agent loop bounds.
  MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(8),
  TASK_BUDGET_TOKENS: z.coerce.number().int().min(20000).default(64000),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Sign-in. "none" is for local development and tests only: every request
  // is one local user. Deployments set "cognito" (infra/aws/ecs.tf).
  AUTH_MODE: z.enum(["cognito", "none"]).default("none"),
  COGNITO_USER_POOL_ID: z.string().regex(/^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/, "COGNITO_USER_POOL_ID looks like us-east-1_AbC123").optional(),
  COGNITO_CLIENT_ID: z.string().min(1).optional(),
  // The shared "Try the demo" account. Its password stays on the server.
  DEMO_USERNAME: z.string().min(1).optional(),
  DEMO_PASSWORD: z.string().min(1).optional(),

  // Spend limits, enforced before each turn (src/lib/usage-limits.ts).
  TURNS_PER_HOUR: z.coerce.number().int().positive().default(20),
  USER_TOKENS_PER_DAY: z.coerce.number().int().positive().default(300_000),
  GLOBAL_TOKENS_PER_DAY: z.coerce.number().int().positive().default(3_000_000),
}).superRefine((value, ctx) => {
  if (value.AUTH_MODE === "cognito") {
    for (const key of ["COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID"] as const) {
      if (!value[key]) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required when AUTH_MODE=cognito` });
    }
  }
  if (Boolean(value.DEMO_USERNAME) !== Boolean(value.DEMO_PASSWORD)) {
    ctx.addIssue({ code: "custom", path: ["DEMO_PASSWORD"], message: "Set both DEMO_USERNAME and DEMO_PASSWORD, or neither" });
  }
});

export type Env = z.infer<typeof EnvSchema>;

/** Pure parse — exported separately so tests can exercise validation without process.exit. */
export function parseEnv(source: NodeJS.ProcessEnv): z.ZodSafeParseResult<Env> {
  return EnvSchema.safeParse(source);
}

function loadEnv(): Env {
  const result = parseEnv(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return result.data;
}

// Tests get real values from vitest.config.ts's `test.env` block, so this
// runs the same validation path as production rather than special-casing
// the test runner — a broken env schema should fail tests too.
export const env: Env = loadEnv();
