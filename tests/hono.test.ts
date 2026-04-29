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

  it("awaits the flush when no executionCtx (Vercel Node fallback)", async () => {
    // Regression: `hono/vercel`'s adapter is `(req) => app.fetch(req)` and
    // never wires `executionCtx`. The old fire-and-forget fallback let
    // Vercel tear the function down before the BQ POST completed, dropping
    // events. The middleware must await before returning so the batch lands.
    const { a, sent } = mockAnalytics();
    const middleware = honoFlushMiddleware(a);
    a.track("foo", {}, { userId: "u" });
    await middleware({}, async () => {});
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
    expect(sent).toHaveLength(1);
  });

  it("accepts a getter so it works with module-singleton patterns", async () => {
    const { a, sent } = mockAnalytics();
    const getter = () => a;
    const middleware = honoFlushMiddleware(getter);
    a.track("foo", {}, { userId: "u" });
    await middleware({}, async () => {});
    expect(sent).toHaveLength(1);
  });

  it("uses opts.waitUntil when provided (Vercel Node fast path)", async () => {
    const { a, sent } = mockAnalytics();
    const waitUntil = vi.fn((_p: Promise<unknown>) => {});
    const middleware = honoFlushMiddleware(a, { waitUntil });
    a.track("foo", {}, { userId: "u" });

    // No executionCtx wired — explicit waitUntil should still win.
    await middleware({}, async () => {});
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0]![0];
    expect(sent).toHaveLength(1);
  });

  it("opts.waitUntil takes precedence over executionCtx.waitUntil", async () => {
    const { a } = mockAnalytics();
    const explicit = vi.fn((_p: Promise<unknown>) => {});
    const ctxWaitUntil = vi.fn();
    const middleware = honoFlushMiddleware(a, { waitUntil: explicit });
    a.track("foo", {}, { userId: "u" });
    await middleware({ executionCtx: { waitUntil: ctxWaitUntil } }, async () => {});
    expect(explicit).toHaveBeenCalledOnce();
    expect(ctxWaitUntil).not.toHaveBeenCalled();
  });

  it("await fallback is bounded by flushTimeoutMs when BQ stalls", async () => {
    // Regression: without a bound, a stuck BQ fetch parks the Hono response
    // until Node's connection timeout (tens of seconds). Cap the wait so the
    // user-visible response stays fast even if the batch is lost.
    let resolveSend: (() => void) | undefined;
    const a = new Analytics({
      transport: {
        send: () => new Promise<void>((r) => { resolveSend = r; }),
      },
    });
    a.track("foo", {}, { userId: "u" });

    const middleware = honoFlushMiddleware(a, { flushTimeoutMs: 25 });
    const start = Date.now();
    await middleware({}, async () => {});
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    // Unblock the send so the test doesn't leave a dangling promise.
    resolveSend?.();
  });

  it("opts.waitUntil swallows flush errors so the response isn't tainted", async () => {
    // Regression: errors from a.flush() that escape into the waitUntil sink
    // can blow up Vercel's background runner. The middleware catches them
    // for the same reason the fire-and-forget fallback historically did.
    const a = new Analytics({
      transport: {
        async send() {
          throw new Error("boom");
        },
      },
    });
    a.track("foo", {}, { userId: "u" });

    let queued: Promise<unknown> | undefined;
    const waitUntil = (p: Promise<unknown>) => {
      queued = p;
    };
    const middleware = honoFlushMiddleware(a, { waitUntil });
    await middleware({}, async () => {});
    await expect(queued).resolves.toBeUndefined();
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
