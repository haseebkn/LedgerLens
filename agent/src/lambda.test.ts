import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { streamHandle } from "hono/aws-lambda";
import { initLambdaApp } from "./lambda.js";

describe("Lambda streaming entrypoint", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).awslambda;
  });

  it("hydrates SSM secrets before loading the app module", async () => {
    const order: string[] = [];
    const fakeApp = new Hono();
    const app = await initLambdaApp({
      hydrate: async () => { order.push("hydrate"); },
      loadApp: async () => { order.push("loadApp"); return { app: fakeApp }; },
    });

    expect(order).toEqual(["hydrate", "loadApp"]);
    expect(app).toBe(fakeApp);
  });

  it("streams SSE chunks progressively through Hono streamHandle", async () => {
    const chunks: string[] = [];
    let metadata: Record<string, unknown> | undefined;

    (globalThis as Record<string, unknown>).awslambda = {
      streamifyResponse: (fn: unknown) => fn,
      HttpResponseStream: {
        from: (stream: Writable, meta: Record<string, unknown>) => {
          metadata = meta;
          return stream;
        },
      },
    };

    const mini = new Hono();
    mini.post("/api/chat", (c) =>
      streamSSE(c, async (stream) => {
        await stream.write(`data: {"type":"text_delta","text":"hello "}\n\n`);
        await stream.write(`data: {"type":"text_delta","text":"world"}\n\n`);
      }),
    );

    const handler = streamHandle(mini) as unknown as (event: unknown, responseStream: Writable, context: unknown) => Promise<void>;
    const responseStream = new Writable({
      write(chunk, _encoding, cb) {
        chunks.push(Buffer.from(chunk).toString("utf-8"));
        cb();
      },
    });

    await handler(
      {
        rawPath: "/api/chat",
        rawQueryString: "",
        headers: { host: "example.lambda-url.us-east-1.on.aws", "content-type": "application/json" },
        requestContext: { http: { method: "POST", path: "/api/chat" }, domainName: "example.lambda-url.us-east-1.on.aws" },
        body: JSON.stringify({ message: "hi" }),
        isBase64Encoded: false,
      },
      responseStream,
      {},
    );

    expect(metadata).toMatchObject({ statusCode: 200 });
    expect(chunks.join("")).toContain(`"text":"hello "`);
    expect(chunks.join("")).toContain(`"text":"world"`);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});
