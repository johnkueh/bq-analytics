import { describe, expect, it, vi } from "vitest";
import { attachWindowErrorHandler } from "../src/transports/browser.js";
import { attachExpoErrorHandler, attachAppStateFlush } from "../src/transports/react-native.js";

function makeMockAnalytics() {
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  return {
    calls,
    log: (...args: unknown[]) => calls.push({ kind: "log", args }),
    track: (...args: unknown[]) => calls.push({ kind: "track", args }),
    flush: vi.fn(async () => {}),
  };
}

describe("attachExpoErrorHandler (RN)", () => {
  it("captures errors via ErrorUtils.setGlobalHandler", () => {
    const a = makeMockAnalytics();
    let installed: ((err: unknown, isFatal?: boolean) => void) | null = null;
    const errorUtils = {
      getGlobalHandler: () => null,
      setGlobalHandler: (fn: (e: unknown, f?: boolean) => void) => {
        installed = fn;
      },
    };
    attachExpoErrorHandler(a as never, errorUtils, { platform: "ios" });
    expect(installed).toBeTypeOf("function");

    installed!(new Error("kaboom"), true);
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]!.kind).toBe("log");
    const [level, msg, fields] = a.calls[0]!.args as [string, string, Record<string, unknown>];
    expect(level).toBe("error");
    expect(msg).toBe("kaboom");
    expect(fields.fatal).toBe(true);
    expect(fields.platform).toBe("ios");
    expect(a.flush).toHaveBeenCalled();
  });

  it("calls previous handler if any", () => {
    const a = makeMockAnalytics();
    const prev = vi.fn();
    let installed: ((err: unknown, isFatal?: boolean) => void) | null = null;
    const errorUtils = {
      getGlobalHandler: () => prev,
      setGlobalHandler: (fn: (e: unknown, f?: boolean) => void) => {
        installed = fn;
      },
    };
    attachExpoErrorHandler(a as never, errorUtils);
    installed!(new Error("x"));
    expect(prev).toHaveBeenCalled();
  });
});

describe("attachAppStateFlush (RN)", () => {
  it("flushes on background, tracks state changes", () => {
    const a = makeMockAnalytics();
    let listener: ((s: string) => void) | null = null;
    const sub = { remove: vi.fn() };
    const appState = {
      addEventListener: (_evt: "change", l: (s: string) => void) => {
        listener = l;
        return sub;
      },
    };
    const detach = attachAppStateFlush(a as never, appState, { userId: "u" });

    listener!("active");
    expect(a.flush).not.toHaveBeenCalled();
    expect(a.calls.find((c) => c.kind === "track")).toBeDefined();

    listener!("background");
    expect(a.flush).toHaveBeenCalled();

    detach();
    expect(sub.remove).toHaveBeenCalled();
  });
});

describe("attachWindowErrorHandler (browser)", () => {
  it("registers error + unhandledrejection listeners and detaches", () => {
    const events = new Set<string>();
    const orig = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      addEventListener: (e: string) => {
        events.add(e);
      },
      removeEventListener: (e: string) => {
        events.delete(e);
      },
    };
    try {
      const a = makeMockAnalytics();
      const detach = attachWindowErrorHandler(a as never);
      expect(events.has("error")).toBe(true);
      expect(events.has("unhandledrejection")).toBe(true);
      detach();
      expect(events.has("error")).toBe(false);
    } finally {
      (globalThis as { window?: unknown }).window = orig;
    }
  });
});
