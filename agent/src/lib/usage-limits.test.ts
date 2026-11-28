import { describe, expect, it } from "vitest";
import { UsageLimiter } from "./usage-limits.js";

const T0 = Date.UTC(2026, 11, 1, 12, 0, 0);
const limits = { turnsPerHour: 3, userTokensPerDay: 1000, globalTokensPerDay: 2500 };

describe("UsageLimiter", () => {
  it("allows N turns per rolling hour, then reports when the oldest one ages out", () => {
    const l = new UsageLimiter(limits);
    for (let i = 0; i < 3; i++) expect(l.begin("u1", T0 + i * 60_000).allowed).toBe(true);
    const fourth = l.begin("u1", T0 + 3 * 60_000);
    expect(fourth).toMatchObject({ allowed: false, reason: "turns_per_hour", retryAfterSeconds: 57 * 60 });
    expect(l.begin("u2", T0 + 3 * 60_000).allowed).toBe(true);
    expect(l.begin("u1", T0 + 60 * 60_000 + 1).allowed).toBe(true);
  });

  it("stops a user at the daily token budget until the next UTC day", () => {
    const l = new UsageLimiter(limits);
    l.begin("u1", T0);
    l.record("u1", 1000, T0);
    expect(l.begin("u1", T0 + 1000)).toMatchObject({ allowed: false, reason: "user_tokens_per_day", retryAfterSeconds: 12 * 3600 - 1 });
    expect(l.begin("u1", Date.UTC(2026, 11, 2, 0, 0, 1)).allowed).toBe(true);
  });

  it("stops everyone at the global daily budget", () => {
    const l = new UsageLimiter(limits);
    l.record("u1", 900, T0);
    l.record("u2", 900, T0);
    l.record("u3", 900, T0);
    expect(l.begin("u4", T0)).toMatchObject({ allowed: false, reason: "global_tokens_per_day" });
  });

  it("does not count a refused turn against the hourly limit", () => {
    const l = new UsageLimiter({ ...limits, turnsPerHour: 1 });
    expect(l.begin("u1", T0).allowed).toBe(true);
    expect(l.begin("u1", T0 + 1).allowed).toBe(false);
    expect(l.begin("u1", T0 + 2).allowed).toBe(false);
    expect(l.begin("u1", T0 + 60 * 60_000 + 1).allowed).toBe(true);
  });
});
