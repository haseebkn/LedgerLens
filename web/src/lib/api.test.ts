import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, errorMessage, getSession, onSessionChange, setSession } from "./api.js";

afterEach(() => {
  setSession(null);
  vi.unstubAllGlobals();
});

describe("session", () => {
  it("treats a session within a minute of expiry as signed out", () => {
    const now = 1_000_000;
    setSession({ accessToken: "t", expiresAt: now + 30_000 });
    expect(getSession(now)).toBeNull();
    setSession({ accessToken: "t", expiresAt: now + 120_000 });
    expect(getSession(now)?.accessToken).toBe("t");
  });

  it("ignores a corrupted stored session", () => {
    sessionStorage.setItem("ledgerlens.session", "{not json");
    expect(getSession()).toBeNull();
  });

  it("notifies listeners and clears the session on a 401", async () => {
    setSession({ accessToken: "t", expiresAt: Date.now() + 3_600_000 });
    const listener = vi.fn();
    const off = onSessionChange(listener);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await apiFetch("/api/metrics");
    expect(getSession()).toBeNull();
    expect(listener).toHaveBeenCalled();
    off();
  });

  it("sends no Authorization header without a session", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/api/metrics");
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).has("Authorization")).toBe(false);
  });
});

describe("errorMessage", () => {
  it("uses the server's error text, or the fallback for non-JSON bodies", async () => {
    expect(await errorMessage(new Response(JSON.stringify({ error: "Slow down" }), { status: 429 }), "x")).toBe("Slow down");
    expect(await errorMessage(new Response("<html>", { status: 502 }), "Bad gateway")).toBe("Bad gateway");
  });
});
