import { describe, expect, it, vi } from "vitest";
import { fetchSsmParameters, hydrateEnvFromSsm, signSsmRequest } from "./ssm.js";

describe("SSM Parameter Store client", () => {
  it("signs GetParameters requests with AWS SigV4 including the session token", () => {
    const signed = signSsmRequest({
      region: "us-east-1",
      body: JSON.stringify({ Names: ["/financial-context/anthropic-api-key"], WithDecryption: true }),
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        sessionToken: "session-token-123",
      },
      now: new Date("2026-11-27T12:00:00.000Z"),
    });

    expect(signed.url).toBe("https://ssm.us-east-1.amazonaws.com/");
    expect(signed.headers["X-Amz-Target"]).toBe("AmazonSSM.GetParameters");
    expect(signed.headers["X-Amz-Date"]).toBe("20261127T120000Z");
    expect(signed.headers["X-Amz-Security-Token"]).toBe("session-token-123");
    expect(signed.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261127\/us-east-1\/ssm\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
  });

  it("fetches and maps decrypted parameter values in one batch call", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload).toEqual({
        Names: ["/app/anthropic-api-key", "/app/demo-password"],
        WithDecryption: true,
      });
      return new Response(
        JSON.stringify({
          Parameters: [
            { Name: "/app/anthropic-api-key", Value: "sk-ant-real" },
            { Name: "/app/demo-password", Value: "SecretPass1234" },
          ],
          InvalidParameters: [],
        }),
        { status: 200 },
      );
    });

    const values = await fetchSsmParameters({
      region: "us-east-1",
      names: ["/app/anthropic-api-key", "/app/demo-password"],
      credentials: { accessKeyId: "AKIA", secretAccessKey: "SECRET" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(values.get("/app/anthropic-api-key")).toBe("sk-ant-real");
    expect(values.get("/app/demo-password")).toBe("SecretPass1234");
  });

  it("hydrates missing secrets when SSM_PREFIX is configured and skips when unset", async () => {
    const noopEnv: NodeJS.ProcessEnv = {};
    const fetchMock = vi.fn();
    await hydrateEnvFromSsm({ targetEnv: noopEnv, fetchImpl: fetchMock as unknown as typeof fetch });
    expect(fetchMock).not.toHaveBeenCalled();

    const lambdaEnv: NodeJS.ProcessEnv = {
      SSM_PREFIX: "/ledgerlens/",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "SECRET",
      AWS_SESSION_TOKEN: "TOK",
      DEMO_USERNAME: "demo",
    };

    const ssmFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          Parameters: [
            { Name: "/ledgerlens/anthropic-api-key", Value: "sk-ant-from-ssm" },
            { Name: "/ledgerlens/demo-password", Value: "DemoPassword1234" },
          ],
        }),
        { status: 200 },
      ),
    );

    await hydrateEnvFromSsm({ targetEnv: lambdaEnv, fetchImpl: ssmFetch as unknown as typeof fetch });
    expect(lambdaEnv.ANTHROPIC_API_KEY).toBe("sk-ant-from-ssm");
    expect(lambdaEnv.DEMO_PASSWORD).toBe("DemoPassword1234");
  });

  it("fails loudly with CLI guidance when a required SSM parameter is missing", async () => {
    const lambdaEnv: NodeJS.ProcessEnv = {
      SSM_PREFIX: "/ledgerlens",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "SECRET",
    };

    const ssmFetch = vi.fn(async () =>
      new Response(JSON.stringify({ Parameters: [], InvalidParameters: ["/ledgerlens/anthropic-api-key"] }), { status: 200 }),
    );

    await expect(
      hydrateEnvFromSsm({ targetEnv: lambdaEnv, fetchImpl: ssmFetch as unknown as typeof fetch }),
    ).rejects.toThrow(/Missing SSM parameter.*\/ledgerlens\/anthropic-api-key.*aws ssm put-parameter/);
  });
});
