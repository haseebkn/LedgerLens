import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
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
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/api/metrics", async (c) => {
  try {
    return c.json(await getMetrics());
  } catch (e) {
    return c.json({ error: "Failed to compute metrics", detail: e instanceof Error ? e.message : String(e) }, 500);
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
    return c.json({ error: "Failed to fetch trace", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// Opens a cited row or computed result for the UI's source drawer. Source
// rows come from the warehouse (parameterized); computed_* ids from the
// in-process result store. Scope to the signed-in user once auth lands.
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

  const history: BetaMessageParam[] = parsed.data.history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  return streamSSE(c, async (stream) => {
    const events: AgentStreamEvent[] = [];
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());
    c.req.raw.signal?.addEventListener("abort", () => controller.abort(), { once: true });
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
      if (controller.signal.aborted && !events.some((event) => event.type === "done" || (event.type === "error" && event.fatal))) {
        events.push({
          type: "error", traceId: events[0]?.traceId ?? "unknown", fatal: true,
          message: "Client disconnected", code: "client_aborted",
        });
      }
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

// Only start listening when this file is run directly (`tsx src/index.ts` /
// `node dist/index.js`) — importing `app` for tests must not bind a port.
// Compares resolved filesystem paths (via fileURLToPath) rather than raw
// strings, since a naive `file://` string comparison breaks on Windows
// (backslash vs forward-slash path separators, drive-letter casing).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, (info) => {
    // eslint-disable-next-line no-console
    console.log(`Agent service listening on http://localhost:${info.port}`);
  });
}

export { app };
