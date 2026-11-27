import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { cognitoSignIn, LOCAL_USER_ID, requireAuth, type AuthVariables } from "./auth.js";

function appWith(mode: "cognito" | "none", verify?: (t: string) => Promise<{ sub: string }>) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireAuth({ mode, verify }));
  app.get("/who", (c) => c.json({ userId: c.get("userId") }));
  return app;
}

describe("requireAuth", () => {
  it("treats every request as the local user in none mode", async () => {
    expect(await (await appWith("none").request("/who")).json()).toEqual({ userId: LOCAL_USER_ID });
  });

  it("rejects a missing or malformed Authorization header with 401", async () => {
    const verify = vi.fn();
    const app = appWith("cognito", verify);
    expect((await app.request("/who")).status).toBe(401);
    expect((await app.request("/who", { headers: { Authorization: "Basic abc" } })).status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });

  it("puts the verified subject on the context", async () => {
    const app = appWith("cognito", async (token) => {
      if (token !== "good") throw new Error("bad");
      return { sub: "user-123" };
    });
    const ok = await app.request("/who", { headers: { Authorization: "Bearer good" } });
    expect(await ok.json()).toEqual({ userId: "user-123" });
    const bad = await app.request("/who", { headers: { Authorization: "Bearer forged" } });
    expect(bad.status).toBe(401);
    expect(await bad.text()).not.toContain("bad");
  });

  it("refuses to build Cognito mode without a verifier", () => {
    expect(() => requireAuth({ mode: "cognito" })).toThrow(/verifier/);
  });
});

describe("cognitoSignIn", () => {
  it("calls InitiateAuth with USER_PASSWORD_AUTH and returns the access token", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: "client" });
      expect((init?.headers as Record<string, string>)["X-Amz-Target"]).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
      return new Response(JSON.stringify({ AuthenticationResult: { AccessToken: "at", ExpiresIn: 3600 } }));
    });
    const result = await cognitoSignIn({ region: "us-east-1", clientId: "client", username: "demo", password: "pw", fetchImpl });
    expect(result).toEqual({ accessToken: "at", expiresIn: 3600 });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
  });

  it("throws on a Cognito error without echoing the password", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ __type: "NotAuthorizedException" }), { status: 400 });
    await expect(cognitoSignIn({ region: "us-east-1", clientId: "c", username: "demo", password: "s3cret", fetchImpl }))
      .rejects.toThrow(/NotAuthorizedException/);
    await expect(cognitoSignIn({ region: "us-east-1", clientId: "c", username: "demo", password: "s3cret", fetchImpl }))
      .rejects.not.toThrow(/s3cret/);
  });
});
