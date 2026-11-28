import { createHash, createHmac } from "node:crypto";

/**
 * Zero-dependency AWS SSM Parameter Store (Standard SecureString) loader for
 * AWS Lambda cold starts. Standard parameters are Always Free on AWS (unlike
 * Secrets Manager's per-secret monthly fee), and fetching them at cold start
 * keeps ANTHROPIC_API_KEY and DEMO_PASSWORD out of Terraform state and Lambda
 * environment variables.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SsmFetchOptions {
  region: string;
  names: string[];
  credentials: AwsCredentials;
  now?: Date;
  fetchImpl?: typeof fetch;
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/** Signs a POST request to SSM's JSON RPC endpoint using AWS Signature Version 4. */
export function signSsmRequest(params: {
  region: string;
  body: string;
  credentials: AwsCredentials;
  now?: Date;
}): { url: string; headers: Record<string, string> } {
  const host = `ssm.${params.region}.amazonaws.com`;
  const { amzDate, dateStamp } = formatAmzDate(params.now ?? new Date());
  const payloadHash = sha256Hex(params.body);

  const rawHeaders: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host,
    "x-amz-date": amzDate,
    "x-amz-target": "AmazonSSM.GetParameters",
  };
  if (params.credentials.sessionToken) {
    rawHeaders["x-amz-security-token"] = params.credentials.sessionToken;
  }

  const headerKeys = Object.keys(rawHeaders).sort();
  const canonicalHeaders = headerKeys.map((k) => `${k}:${rawHeaders[k]!.trim()}\n`).join("");
  const signedHeaders = headerKeys.join(";");
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const credentialScope = `${dateStamp}/${params.region}/ssm/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${params.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, params.region);
  const kService = hmac(kRegion, "ssm");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const headers: Record<string, string> = {
    "Content-Type": rawHeaders["content-type"]!,
    "X-Amz-Date": amzDate,
    "X-Amz-Target": rawHeaders["x-amz-target"]!,
    Authorization: `AWS4-HMAC-SHA256 Credential=${params.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (params.credentials.sessionToken) {
    headers["X-Amz-Security-Token"] = params.credentials.sessionToken;
  }

  return { url: `https://${host}/`, headers };
}

/** Fetches decrypted SSM parameters in one GetParameters batch call. */
export async function fetchSsmParameters(options: SsmFetchOptions): Promise<Map<string, string>> {
  if (options.names.length === 0) return new Map();
  const body = JSON.stringify({ Names: options.names, WithDecryption: true });
  const { url, headers } = signSsmRequest({
    region: options.region,
    body,
    credentials: options.credentials,
    now: options.now,
  });

  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(5_000),
  });

  const json = (await response.json().catch(() => null)) as {
    Parameters?: { Name?: string; Value?: string }[];
    InvalidParameters?: string[];
    message?: string;
    __type?: string;
  } | null;

  if (!response.ok || !json) {
    throw new Error(`SSM GetParameters failed (${response.status} ${json?.__type ?? json?.message ?? "unknown"})`);
  }

  const values = new Map<string, string>();
  for (const param of json.Parameters ?? []) {
    if (param.Name && typeof param.Value === "string") {
      values.set(param.Name, param.Value);
    }
  }
  return values;
}

const SECRET_SPECS: readonly { suffix: string; envKey: string; required: (env: NodeJS.ProcessEnv) => boolean }[] = [
  { suffix: "anthropic-api-key", envKey: "ANTHROPIC_API_KEY", required: () => true },
  { suffix: "demo-password", envKey: "DEMO_PASSWORD", required: (e) => Boolean(e.DEMO_USERNAME) },
];

/**
 * Hydrates missing secrets in targetEnv from SSM Parameter Store when
 * SSM_PREFIX is set (e.g. "/financial-context"). Runs once on Lambda cold
 * start before config.ts parses process.env.
 */
export async function hydrateEnvFromSsm(options?: {
  targetEnv?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<void> {
  const targetEnv = options?.targetEnv ?? process.env;
  const rawPrefix = targetEnv.SSM_PREFIX?.trim();
  if (!rawPrefix) return;

  const prefix = rawPrefix.replace(/\/+$/, "");
  const needed = SECRET_SPECS.filter((spec) => !targetEnv[spec.envKey] && spec.required(targetEnv));
  if (needed.length === 0) return;

  const region = targetEnv.AWS_REGION ?? targetEnv.AWS_DEFAULT_REGION;
  const accessKeyId = targetEnv.AWS_ACCESS_KEY_ID;
  const secretAccessKey = targetEnv.AWS_SECRET_ACCESS_KEY;
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error("SSM_PREFIX is set, but AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are missing.");
  }

  const names = needed.map((spec) => `${prefix}/${spec.suffix}`);
  const fetched = await fetchSsmParameters({
    region,
    names,
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken: targetEnv.AWS_SESSION_TOKEN,
    },
    fetchImpl: options?.fetchImpl,
    now: options?.now,
  });

  const missing: string[] = [];
  for (const spec of needed) {
    const fullName = `${prefix}/${spec.suffix}`;
    const value = fetched.get(fullName);
    if (!value) {
      missing.push(fullName);
    } else {
      targetEnv[spec.envKey] = value;
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing SSM parameter(s): ${missing.join(", ")}. Set them with: aws ssm put-parameter --name <name> --type SecureString --value <value> --overwrite`,
    );
  }
}
