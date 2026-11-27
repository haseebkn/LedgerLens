/**
 * Every call to the agent API goes through apiFetch, which attaches the
 * signed-in session's access token and signs the user out on a 401. The
 * token lives in sessionStorage: it survives a reload, not a closed tab.
 */

export interface Session {
  accessToken: string;
  /** Epoch ms; the session is treated as gone a minute before this. */
  expiresAt: number;
}

export interface AuthConfig {
  authRequired: boolean;
  demoAvailable: boolean;
}

const STORAGE_KEY = "ledgerlens.session";
const EXPIRY_MARGIN_MS = 60_000;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function getSession(now = Date.now()): Session | null {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as Session;
    if (typeof session.accessToken !== "string" || !(session.expiresAt - EXPIRY_MARGIN_MS > now)) return null;
    return session;
  } catch {
    return null;
  }
}

export function setSession(session: Session | null): void {
  const store = storage();
  if (session) store?.setItem(STORAGE_KEY, JSON.stringify(session));
  else store?.removeItem(STORAGE_KEY);
  listeners.forEach((fn) => fn());
}

export function onSessionChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const session = getSession();
  const headers = new Headers(init.headers);
  if (session) headers.set("Authorization", `Bearer ${session.accessToken}`);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401 && session) setSession(null);
  return response;
}

/** The server's user-facing `error` text, or a fallback. */
export async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON: use the fallback.
  }
  return fallback;
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  try {
    const response = await fetch("/api/auth/config");
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as AuthConfig;
  } catch {
    // The server enforces auth regardless; if discovery fails, show the app
    // and let its requests report what is wrong.
    return { authRequired: false, demoAvailable: false };
  }
}

export async function signInAsDemo(now = Date.now()): Promise<void> {
  const response = await fetch("/api/auth/demo", { method: "POST" });
  if (!response.ok) throw new Error(await errorMessage(response, "The demo account is unavailable right now."));
  const { accessToken, expiresIn } = (await response.json()) as { accessToken: string; expiresIn: number };
  setSession({ accessToken, expiresAt: now + expiresIn * 1000 });
}
