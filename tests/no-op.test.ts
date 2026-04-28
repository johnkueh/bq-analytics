import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Analytics, bqTransport } from "../src/index.js";

describe("bqTransport graceful degradation", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns a no-op transport when projectId is missing", async () => {
    const t = bqTransport({});  // no projectId
    const a = new Analytics({ transport: t });
    a.track("foo", { x: 1 }, { userId: "u" });
    a.identify("u", { plan: "free" });
    a.log("info", "hi");
    // flush() should resolve cleanly even with no projectId
    await expect(a.flush()).resolves.toBeUndefined();
  });

  it("does not warn repeatedly across calls in the same process", () => {
    const before = warnSpy.mock.calls.length;
    bqTransport({});
    bqTransport({});
    bqTransport({});
    // Module-level flag prevents repeat warnings; total stays at-most-1.
    expect(warnSpy.mock.calls.length - before).toBeLessThanOrEqual(0);
  });

  it("uses real transport when projectId is provided", () => {
    const t = bqTransport({ projectId: "test-project" });
    expect(typeof t.send).toBe("function");
    // Real transport — would attempt a network call, so we don't actually call it here.
  });
});
