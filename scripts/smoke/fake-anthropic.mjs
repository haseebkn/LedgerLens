// A stand-in for the Anthropic Messages API, for CI smoke tests: no key, no
// network, no cost. It speaks the streaming protocol the SDK expects and
// drives one real tool call:
//
//   1st request  -> streams a tool_use for summarize_spend over the seed's
//                   date range (the agent runs it against the warehouse).
//   2nd request  -> reads the tool_result, streams an answer in several
//                   deltas that cites the result_id and states its total.
//
// The text streams with short pauses so a client can prove tokens arrive
// before the message completes.
//
//   node scripts/smoke/fake-anthropic.mjs        (PORT, default 9999)
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 9999);
const PAUSE_MS = Number(process.env.FAKE_PAUSE_MS ?? 150);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let requests = 0;

function frame(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function toolResultText(messages) {
  for (const message of [...messages].reverse()) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const content = block.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.map((c) => c.text ?? "").join("");
    }
  }
  return null;
}

async function stream(res, model, blocks, stopReason) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  frame(res, "message_start", {
    message: {
      id: `msg_fake_${++requests}`, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text") {
      frame(res, "content_block_start", { index, content_block: { type: "text", text: "" } });
      for (const piece of block.pieces) {
        frame(res, "content_block_delta", { index, delta: { type: "text_delta", text: piece } });
        await sleep(PAUSE_MS);
      }
    } else {
      frame(res, "content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      frame(res, "content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    frame(res, "content_block_stop", { index });
  }
  frame(res, "message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 40 } });
  frame(res, "message_stop", {});
  res.end();
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://fake");
  if (req.method === "GET" && url.pathname === "/health") return res.end("ok");
  if (req.method !== "POST" || !url.pathname.endsWith("/v1/messages")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: url.pathname } }));
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const result = toolResultText(body.messages ?? []);

  if (result === null) {
    return stream(res, body.model, [
      { type: "text", pieces: ["Let me total that up."] },
      {
        type: "tool_use", id: `toolu_fake_${requests + 1}`, name: "summarize_spend",
        input: { start: "2026-06-01", end: "2026-12-01", group_by: "category", transaction_type: "spend" },
      },
    ], "tool_use");
  }

  let resultId = null;
  let total = null;
  try {
    const parsed = JSON.parse(result);
    resultId = parsed.result_id ?? null;
    total = typeof parsed.grand_total === "number" ? parsed.grand_total : null;
  } catch {
    // Not JSON: answer without a citation; the smoke client fails that.
  }
  const amount = total === null
    ? "an unknown amount"
    : `$${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const cite = resultId ? ` [${resultId}]` : "";
  return stream(res, body.model, [
    { type: "text", pieces: ["Across", " June to November,", " you spent", ` ${amount}${cite}.`] },
  ], "end_turn");
}).listen(PORT, "0.0.0.0", () => console.log(`fake Anthropic API on :${PORT}`));
