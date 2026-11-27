import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryRows: vi.fn() }));
vi.mock("./duckdb.js", () => ({ queryRows: mocks.queryRows }));
import { checkReadiness, checkRetrieval, checkWarehouse } from "./readiness.js";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("readiness checks", () => {
  it("reports the warehouse ok when a context row can be read", async () => {
    mocks.queryRows.mockResolvedValue([{ row_id: "plaid_1" }]);
    expect(await checkWarehouse()).toBe("ok");
  });

  it("reports the warehouse failed when DuckDB can't open it", async () => {
    mocks.queryRows.mockRejectedValue(new Error("IO Error: file not found"));
    expect(await checkWarehouse()).toBe("failed");
  });

  it("reports retrieval failed on a non-2xx /health or a network error", async () => {
    expect(await checkRetrieval(async () => new Response("{}", { status: 503 }))).toBe("failed");
    expect(await checkRetrieval(async () => { throw new TypeError("fetch failed"); })).toBe("failed");
    expect(await checkRetrieval(async () => new Response("{}", { status: 200 }))).toBe("ok");
  });

  it("is ready only when both checks pass", async () => {
    mocks.queryRows.mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    expect(await checkReadiness()).toEqual({ ready: false, checks: { warehouse: "ok", retrieval: "failed" } });
    vi.unstubAllGlobals();
  });
});
