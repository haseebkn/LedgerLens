// End-to-end smoke test against a running deployment or compose stack:
//
//   BASE_URL=https://ledgerlens.example.com node scripts/smoke/smoke.mjs
//
// Checks /api/health and /api/ready, signs in as the demo user when the
// server requires sign-in (and checks that an unauthenticated chat gets a
// 401), asks one question, and asserts that answer text streams in before
// done and that the answer carries a citation. Exits non-zero with the
// reason otherwise.
//
// EXPECT_STREAMING_GAP_MS=300 additionally fails if the first token arrived
// less than that long before done, i.e. the answer was buffered.
const BASE_URL = (process.env.BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const QUESTION = process.env.SMOKE_QUESTION ?? "How much did I spend from June through November, by category?";
const READY_ATTEMPTS = Number(process.env.READY_ATTEMPTS ?? 30);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
}

async function expectOk(path) {
  const res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) fail(`${path} returned ${res.status}: ${await res.text()}`);
  console.log(`ok   ${path}`);
}

async function waitReady() {
  for (let attempt = 1; attempt <= READY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/api/ready`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        console.log(`ok   /api/ready (attempt ${attempt})`);
        return;
      }
      console.log(`wait /api/ready ${res.status} ${await res.text()}`);
    } catch (e) {
      console.log(`wait /api/ready ${e.message}`);
    }
    await sleep(5_000);
  }
  fail(`/api/ready never succeeded after ${READY_ATTEMPTS} attempts`);
}

async function authHeaders() {
  const config = await (await fetch(`${BASE_URL}/api/auth/config`)).json();
  if (!config.authRequired) return {};
  const unauthenticated = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }),
  });
  if (unauthenticated.status !== 401) fail(`unauthenticated /api/chat returned ${unauthenticated.status}, expected 401`);
  console.log("ok   unauthenticated /api/chat -> 401");
  const demo = await fetch(`${BASE_URL}/api/auth/demo`, { method: "POST" });
  if (!demo.ok) fail(`demo sign-in returned ${demo.status}: ${await demo.text()}`);
  console.log("ok   demo sign-in");
  return { Authorization: `Bearer ${(await demo.json()).accessToken}` };
}

async function ask(headers) {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ message: QUESTION }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) fail(`/api/chat returned ${res.status}: ${await res.text()}`);
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTextAt = null;
  let doneAt = null;
  let text = "";
  const types = [];
  const citations = [];
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data) continue; // keepalive comments carry no data
      const event = JSON.parse(data);
      types.push(event.type);
      if (event.type === "text_delta") {
        text += event.text;
        firstTextAt ??= Date.now();
      }
      if (event.type === "citation") citations.push(event.rowId);
      if (event.type === "error" && event.fatal) fail(`agent error: ${event.message}`);
      if (event.type === "done") doneAt = Date.now();
    }
  }
  if (doneAt === null) fail(`stream ended without done (events: ${types.join(", ")})`);
  if (firstTextAt === null) fail("no text_delta events");
  if (types.indexOf("text_delta") > types.indexOf("done")) fail("text arrived after done");
  if (citations.length === 0) fail(`answer has no citation: ${JSON.stringify(text)}`);
  const deltas = types.filter((t) => t === "text_delta").length;
  console.log(`ok   streamed answer: first token ${firstTextAt - started} ms, done ${doneAt - started} ms, ${deltas} deltas`);
  console.log(`ok   cited ${citations.join(", ")}`);
  console.log(`     ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  return { firstTextMs: firstTextAt - started, doneMs: doneAt - started };
}

await expectOk("/api/health");
await waitReady();
const headers = await authHeaders();
const timing = await ask(headers);
if (process.env.EXPECT_STREAMING_GAP_MS) {
  const gap = timing.doneMs - timing.firstTextMs;
  if (gap < Number(process.env.EXPECT_STREAMING_GAP_MS)) {
    fail(`first token arrived only ${gap} ms before done; the answer was buffered, not streamed`);
  }
  console.log(`ok   first token ${gap} ms before done (streaming, not buffered)`);
}
console.log("SMOKE PASS");
