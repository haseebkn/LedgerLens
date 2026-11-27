import { Hono, type Context, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { env } from "./config.js";
import { runAgentTurn } from "./agent-loop.js";
import { toSseFrame, type AgentStreamEvent } from "./streaming-types.js";
import { buildTraceRecord } from "./lib/trace-accumulator.js";
import { writeTraceRecord } from "./lib/trace-writer.js";
import { getMetrics, getTraceById } from "./lib/metrics.js";
import { getLatestEvalReport } from "./lib/eval-reports.js";
import { getRowById, ROW_ID_FORMAT } from "./lib/rows.js";
import { checkReadiness } from "./lib/readiness.js";
import { cognitoSignIn, cognitoVerifier, requireAuth, type AuthVariables, type SignInResult, type VerifyToken } from "./lib/auth.js";
import { UsageLimiter } from "./lib/usage-limits.js";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export interface AppOptions {
  authMode: "cognito" | "none";
  verify?: VerifyToken;
  limiter: UsageLimiter;
  /** Signs in the shared demo user server-side; absent when no demo user is configured. */
  demoSignIn?: () => Promise<SignInResult>;
  /** SSE comment interval, so a long tool step never reaches the ALB's 60 s idle timeout. */
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

/** Routes anyone may call: liveness, readiness, and how to sign in. */
const PUBLIC_PATHS = new Set(["/api/health", "/api/ready", "/api/auth/config", "/api/auth/demo"]);

const ChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      })
    )
    .max(40)
    .default([]),
}).refine(
  ({ message, history }) => message.length + history.reduce((sum, item) => sum + item.content.length, 0) <= 64000,
  { message: "Conversation exceeds the 64000-character context limit" },
);

function workingTokens(events: AgentStreamEvent[], question: string): number {
  const r = buildTraceRecord(events, question);
  return r.input_tokens + r.output_tokens + r.cache_creation_input_tokens + r.cache_read_input_tokens;
}

export function createApp(options: AppOptions) {
  const app = new Hono<{ Variables: AuthVariables }>();

  // nosniff, frame denial, no referrer leakage, etc. on every API response.
  app.use("*", secureHeaders());

  // Liveness only: no I/O, so it is safe as the load balancer's health check.
  // A fresh deploy with no traces table must still go healthy.
  // The /api/* aliases exist because the public ALB only forwards /api/* to
  // this service; the target-group health check hits the task directly.
  const health = (c: Context) => c.json({ status: "ok" });
  app.get("/health", health);
  app.get("/api/health", health);

  // Readiness: the warehouse opens and the retrieval service answers. For the
  // deploy smoke test and operators; not the ALB check (see lib/readiness.ts).
  const ready = async (c: Context) => {
    const readiness = await checkReadiness();
    return c.json({ status: readiness.ready ? "ready" : "not_ready", checks: readiness.checks }, readiness.ready ? 200 : 503);
  };
  app.get("/ready", ready);
  app.get("/api/ready", ready);

  app.get("/api/auth/config", (c) => c.json({ authRequired: options.authMode === "cognito", demoAvailable: Boolean(options.demoSignIn) }));

  // "Try the demo": the server signs in the shared demo user, so its password
  // never reaches the browser. The demo user has the same per-user limits as
  // anyone else; the ALB's WAF rate rule limits how often this can be called.
  app.post("/api/auth/demo", async (c) => {
    if (!options.demoSignIn) return c.json({ error: "The demo account is not enabled." }, 404);
    try {
      return c.json(await options.demoSignIn());
    } catch (e) {
      console.error("Demo sign-in failed:", e);
      return c.json({ error: "The demo account is unavailable right now. Please try again later." }, 503);
    }
  });

  const auth = requireAuth({ mode: options.authMode, verify: options.verify });
  const protect: MiddlewareHandler<{ Variables: AuthVariables }> = (c, next) => (PUBLIC_PATHS.has(c.req.path) ? next() : auth(c, next));
  app.use("/api/*", protect);

  app.get("/api/metrics", async (c) => {
    try {
      return c.json(await getMetrics());
    } catch (e) {
      console.error("Metrics query failed:", e);
      return c.json({ error: "Metrics are unavailable. The traces table may not be built yet." }, 500);
    }
  });

  app.get("/api/evals/latest", (c) => {
    const report = getLatestEvalReport();
    if (!report) return c.json({ error: "No eval report yet — run `npm run eval` in agent/." }, 404);
    return c.json(report);
  });

  app.get("/api/traces/:id", async (c) => {
    const traceId = c.req.param("id");
    try {
      const trace = await getTraceById(traceId);
      if (!trace) return c.json({ error: "Trace not found" }, 404);
      return c.json(trace);
    } catch (e) {
      console.error("Trace lookup failed:", e);
      return c.json({ error: "Failed to fetch trace" }, 500);
    }
  });

  // Opens a cited row or computed result for the UI's source drawer. Source
  // rows come from the warehouse (parameterized); computed_* ids from the
  // in-process result store. Every caller sees the same single dataset today;
  // per-advisor scoping arrives with Postgres row-level security (Phase 3).
  app.get("/api/rows/:rowId", async (c) => {
    const rowId = c.req.param("rowId");
    if (!ROW_ID_FORMAT.test(rowId)) return c.json({ error: "Invalid row id" }, 400);
    try {
      const row = await getRowById(rowId);
      if (!row) {
        return c.json({
          error: rowId.startsWith("computed_")
            ? "This computed result is no longer available. Ask the question again to recompute it."
            : "Row not found",
        }, 404);
      }
      return c.json(row);
    } catch (e) {
      console.error("Row lookup failed:", e);
      return c.json({ error: "Failed to load the source row" }, 500);
    }
  });

  app.use("/api/chat", bodyLimit({
    maxSize: 128 * 1024,
    onError: (c) => c.json({ error: "Request body exceeds 128 KiB" }, 413),
  }));

  app.post("/api/chat", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ChatRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }

    const userId = c.get("userId");
    const decision = options.limiter.begin(userId);
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSeconds));
      return c.json({ error: decision.message, reason: decision.reason, retryAfterSeconds: decision.retryAfterSeconds }, 429);
    }

    const history: BetaMessageParam[] = parsed.data.history.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    return streamSSE(c, async (stream) => {
      const events: AgentStreamEvent[] = [];
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      c.req.raw.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      // SSE comment lines carry no event, so clients ignore them, but they keep
      // the connection from looking idle to the load balancer.
      const heartbeat = setInterval(() => {
        if (!stream.aborted) stream.write(": keepalive\n\n").catch(() => {});
      }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
      try {
        for await (const event of runAgentTurn({ history, userMessage: parsed.data.message, signal: controller.signal })) {
          events.push(event);
          if (!stream.aborted) await stream.write(toSseFrame(event));
          if (event.type === "done" || (event.type === "error" && event.fatal)) break;
        }
      } catch (e) {
        console.error("Agent response failed:", e);
        const event: AgentStreamEvent = {
          type: "error", traceId: events[0]?.traceId ?? "unknown", fatal: true,
          message: "The response was interrupted. Please try again.",
        };
        events.push(event);
        if (!stream.aborted) await stream.write(toSseFrame(event));
      } finally {
        clearInterval(heartbeat);
        if (controller.signal.aborted && !events.some((event) => event.type === "done" || (event.type === "error" && event.fatal))) {
          events.push({
            type: "error", traceId: events[0]?.traceId ?? "unknown", fatal: true,
            message: "Client disconnected", code: "client_aborted",
          });
        }
        // Charge what the turn actually used, including a failed or abandoned one.
        options.limiter.record(userId, workingTokens(events, parsed.data.message));
        // Trace persistence is best-effort: a disk/permissions failure here
        // must never take down the response the user already received.
        try {
          writeTraceRecord(buildTraceRecord(events, parsed.data.message));
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("Failed to persist trace record:", e);
        }
        if (!stream.aborted) await stream.close();
      }
    });
  });

  return app;
}

function optionsFromEnv(): AppOptions {
  const cognito = env.AUTH_MODE === "cognito";
  const demo = cognito && env.DEMO_USERNAME && env.DEMO_PASSWORD
    ? { username: env.DEMO_USERNAME, password: env.DEMO_PASSWORD }
    : null;
  return {
    authMode: env.AUTH_MODE,
    verify: cognito ? cognitoVerifier(env.COGNITO_USER_POOL_ID!, env.COGNITO_CLIENT_ID!) : undefined,
    limiter: new UsageLimiter({
      turnsPerHour: env.TURNS_PER_HOUR,
      userTokensPerDay: env.USER_TOKENS_PER_DAY,
      globalTokensPerDay: env.GLOBAL_TOKENS_PER_DAY,
    }),
    demoSignIn: demo
      ? () => cognitoSignIn({
          region: env.COGNITO_USER_POOL_ID!.split("_")[0]!,
          clientId: env.COGNITO_CLIENT_ID!,
          ...demo,
        })
      : undefined,
  };
}

const app = createApp(optionsFromEnv());

// Only start listening when this file is run directly (`tsx src/index.ts` /
// `node dist/index.js`) — importing `app` for tests must not bind a port.
// Compares resolved filesystem paths (via fileURLToPath) rather than raw
// strings, since a naive `file://` string comparison breaks on Windows
// (backslash vs forward-slash path separators, drive-letter casing).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, (info) => {
    // eslint-disable-next-line no-console
    console.log(`Agent service listening on http://localhost:${info.port} (auth: ${env.AUTH_MODE})`);
  });
}

export { app };
