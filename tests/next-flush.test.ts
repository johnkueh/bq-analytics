import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Analytics } from "../src/index.js";

// Capture the callbacks passed to next/server's `after()` so we can invoke
// them deterministically inside the test rather than waiting on a real Next
// request lifecycle.
const afterCallbacks: Array<() => unknown> = [];
vi.mock("next/server", () => ({
  after: (cb: () => unknown) => afterCallbacks.push(cb),
}));

import { flushAfter } from "../src/handlers/next.js";

function fakeAnalytics(flush: () => Promise<void>): Analytics {
  return { flush } as unknown as Analytics;
}

describe("flushAfter", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
  });

  it("schedules a flush via next/server after() without invoking it", () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    flushAfter(fakeAnalytics(flush));

    expect(afterCallbacks).toHaveLength(1);
    expect(flush).not.toHaveBeenCalled();
  });

  it("flushes when the captured callback is invoked", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    flushAfter(fakeAnalytics(flush));

    await afterCallbacks[0]!();
    expect(flush).toHaveBeenCalledOnce();
  });

  it("resolves a thunk at call time, not at flush time", () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const resolver = vi.fn().mockReturnValue(fakeAnalytics(flush));

    flushAfter(resolver);

    // Eager resolve — caller's lazy singleton is read now, not deferred.
    expect(resolver).toHaveBeenCalledOnce();
  });

  it("swallows flush errors so the response isn't held up", async () => {
    const flush = vi.fn().mockRejectedValue(new Error("BQ unreachable"));
    flushAfter(fakeAnalytics(flush));

    await expect(afterCallbacks[0]!()).resolves.toBeUndefined();
  });

  it("queues a separate after() per call", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const a = fakeAnalytics(flush);

    flushAfter(a);
    flushAfter(a);
    flushAfter(a);

    expect(afterCallbacks).toHaveLength(3);
    for (const cb of afterCallbacks) await cb();
    expect(flush).toHaveBeenCalledTimes(3);
  });
});
