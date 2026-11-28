import { streamHandle } from "hono/aws-lambda";
import { hydrateEnvFromSsm } from "./lib/ssm.js";
import type { Hono } from "hono";

/**
 * AWS Lambda entrypoint (Node.js 22 + Function URL InvokeMode=RESPONSE_STREAM).
 *
 * Hydrates secrets from SSM Parameter Store once on cold start BEFORE
 * importing ./index.js, so config.ts's fail-fast env validation and the
 * Anthropic SDK receive the decrypted values at module initialization time.
 * Every warm invocation runs directly through Hono's streamHandle(app) with
 * progressive SSE token streaming.
 */

export async function initLambdaApp(options?: {
  hydrate?: () => Promise<void>;
  loadApp?: () => Promise<{ app: Hono<any, any, any> }>;
}): Promise<Hono<any, any, any>> {
  await (options?.hydrate ?? hydrateEnvFromSsm)();
  const mod = await (options?.loadApp ?? (() => import("./index.js")))();
  return mod.app;
}

const isLambdaRuntime =
  typeof (globalThis as { awslambda?: { streamifyResponse?: unknown } }).awslambda?.streamifyResponse === "function";

// Only execute cold-start hydration & streamifyResponse when running inside
// AWS Lambda; importing this module in Vitest must not contact AWS.
export const handler = isLambdaRuntime ? streamHandle(await initLambdaApp()) : undefined;
