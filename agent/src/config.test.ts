import { describe, expect, it } from "vitest";
import { parseEnv } from "./config.js";

const required = { ANTHROPIC_API_KEY: "test-key", RETRIEVAL_SERVICE_TOKEN: "test-token" };

describe("service configuration", () => {
  it("keeps local launches on loopback and permits an explicit container bind", () => {
    const local = parseEnv(required);
    expect(local.success && local.data.HOST).toBe("127.0.0.1");
    const container = parseEnv({ ...required, HOST: "0.0.0.0", PORT: "9000" });
    expect(container.success && container.data.HOST).toBe("0.0.0.0");
    expect(container.success && container.data.PORT).toBe(9000);
  });

  it("treats an empty ANTHROPIC_BASE_URL as unset and rejects a malformed one", () => {
    const unset = parseEnv({ ...required, ANTHROPIC_BASE_URL: "" });
    expect(unset.success && unset.data.ANTHROPIC_BASE_URL).toBeUndefined();
    const fake = parseEnv({ ...required, ANTHROPIC_BASE_URL: "http://fake-anthropic:9999" });
    expect(fake.success && fake.data.ANTHROPIC_BASE_URL).toBe("http://fake-anthropic:9999");
    expect(parseEnv({ ...required, ANTHROPIC_BASE_URL: "not a url" }).success).toBe(false);
  });

  it("defaults to local auth and refuses Cognito mode without a pool and client", () => {
    const local = parseEnv(required);
    expect(local.success && local.data.AUTH_MODE).toBe("none");
    const half = parseEnv({ ...required, AUTH_MODE: "cognito", COGNITO_USER_POOL_ID: "us-east-1_AbC123" });
    expect(half.success).toBe(false);
    if (!half.success) expect(half.error.issues.map((i) => i.path.join("."))).toContain("COGNITO_CLIENT_ID");
    const full = parseEnv({ ...required, AUTH_MODE: "cognito", COGNITO_USER_POOL_ID: "us-east-1_AbC123", COGNITO_CLIENT_ID: "client" });
    expect(full.success).toBe(true);
    expect(parseEnv({ ...required, AUTH_MODE: "cognito", COGNITO_USER_POOL_ID: "not-a-pool", COGNITO_CLIENT_ID: "c" }).success).toBe(false);
    expect(parseEnv({ ...required, DEMO_USERNAME: "demo" }).success).toBe(false);
  });

  it.each(["0", "-1", "65536", "not-a-port"])("rejects invalid port %s before boot", (PORT) => {
    expect(parseEnv({ ...required, PORT }).success).toBe(false);
  });
});
