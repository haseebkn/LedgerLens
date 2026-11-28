import type { MiddlewareHandler } from "hono";
import { CognitoJwtVerifier } from "aws-jwt-verify";

/**
 * App-level authentication. The signed-in user's id goes on the request
 * context (c.get("userId")), because per-user limits now, and per-advisor
 * data scoping later, need it inside the app. A load-balancer rule alone
 * would not provide it.
 *
 * Modes:
 * - "cognito": every protected route needs `Authorization: Bearer <access
 *   token>` from the configured Cognito user pool and app client.
 * - "none": local development and tests only. Every request is the single
 *   local user. The deployed task definition sets "cognito".
 */

export type AuthVariables = { userId: string };

export type VerifyToken = (token: string) => Promise<{ sub: string }>;

export function cognitoVerifier(userPoolId: string, clientId: string): VerifyToken {
  const verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "access" });
  return async (token) => {
    const payload = await verifier.verify(token);
    return { sub: payload.sub };
  };
}

export const LOCAL_USER_ID = "local-user";

export function requireAuth(options: { mode: "cognito" | "none"; verify?: VerifyToken }): MiddlewareHandler<{ Variables: AuthVariables }> {
  if (options.mode === "cognito" && !options.verify) {
    throw new Error("AUTH_MODE=cognito needs a token verifier");
  }
  return async (c, next) => {
    if (options.mode === "none") {
      c.set("userId", LOCAL_USER_ID);
      return next();
    }
    const header = c.req.header("Authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return c.json({ error: "Sign in to use LedgerLens." }, 401);
    try {
      const { sub } = await options.verify!(match[1]!);
      c.set("userId", sub);
    } catch {
      // Expired, wrong pool, wrong client or tampered: all the same answer.
      return c.json({ error: "Your session has expired. Sign in again." }, 401);
    }
    return next();
  };
}

/**
 * Signs a user in with Cognito's USER_PASSWORD_AUTH flow. The app client
 * has no secret, so this is a plain JSON call with no AWS credentials.
 * Used for the shared demo user, whose password stays on the server.
 */
export interface SignInResult {
  accessToken: string;
  expiresIn: number;
}

export async function cognitoSignIn(params: {
  region: string;
  clientId: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
}): Promise<SignInResult> {
  const response = await (params.fetchImpl ?? fetch)(`https://cognito-idp.${params.region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: params.clientId,
      AuthParameters: { USERNAME: params.username, PASSWORD: params.password },
    }),
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await response.json().catch(() => null)) as
    | { AuthenticationResult?: { AccessToken?: string; ExpiresIn?: number }; __type?: string }
    | null;
  const result = body?.AuthenticationResult;
  if (!response.ok || !result?.AccessToken) {
    throw new Error(`Cognito sign-in failed (${response.status} ${body?.__type ?? "no result"})`);
  }
  return { accessToken: result.AccessToken, expiresIn: result.ExpiresIn ?? 3600 };
}
