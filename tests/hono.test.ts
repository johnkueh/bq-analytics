import { describe, expect, it, vi } from "vitest";
import { honoFlushMiddleware } from "../src/handlers/hono.js";
import { Analytics } from "../src/index.js";
import type { BufferedRecord, Transport } from "../src/types.js";

function mockAnalytics() {
  const sent: BufferedRecord[][] = [];
  const a = new Analytics({
    transport: {
      async send(records) { sent.push(records); },
    } satisfies Transport,
  });
  return { a, sent };
}

describe("honoFlushMiddleware", () => {
  it("flushes via executionCtx.waitUntil after next()", async () => {
    const { a, sent } = mockAnalytics();
    const middleware = honoFlushMiddleware(a);

    a.track("foo", {}, { userId: "u" });

    const waitUntil = vi.fn((_p: Promise<unknown>) => {});
    const ctx = { executionCtx: { waitUntil } };
    await middleware(ctx, async () => {});

    expect(waitUntil).toHaveBeenCalledOnce();
    // resolve the queued promise so the transport runs
    await waitUntil.mock.calls[0]![0];
    expect(sent).toHaveLength(1);
  });

  it("falls back to fire-and-forget when no executionCtx", async () => {
    const { a, sent } = mockAnalytics();
    const middleware = honoFlushMiddleware(a);
    a.track("foo", {}, { userId: "u" });
    await middleware({}, async () => {});
    // give the microtask a chance
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
  });

  it("survives Hono's executionCtx getter throwing (next dev / hono/node-server)", async () => {
    const { a, sent } = mockAnalytics();
    const middleware = honoFlushMiddleware(a);
    // Real-world Hono behavior: executionCtx is a getter that throws when
    // no context was provided.
    const ctx = Object.defineProperty({} as Record<string, unknown>, "executionCtx", {
      get() {
        throw new Error(
          "This context has no ExecutionContext. Either provide one or use the platform-specific entrypoint",
        );
      },
    });
    a.track("foo", {}, { userId: "u" });
    await expect(middleware(ctx as never, async () => {})).resolves.not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
  });

  it("accepts a getter so it works with module-singleton patterns", async () => {
    const { a, sent } = mockAnalytics();
    const getter = () => a;
    const middleware = honoFlushMiddleware(getter);
    a.track("foo", {}, { userId: "u" });
    await middleware({}, async () => {});
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
  });

  it("runs the wrapped handler before flushing", async () => {
    const order: string[] = [];
    const { a } = mockAnalytics();
    const middleware = honoFlushMiddleware(a);
    const waitUntil = vi.fn();
    const ctx = { executionCtx: { waitUntil } };
    await middleware(ctx, async () => {
      order.push("handler");
    });
    order.push("after");
    expect(order).toEqual(["handler", "after"]);
    expect(waitUntil).toHaveBeenCalled();
  });
});
