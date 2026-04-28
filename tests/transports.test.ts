import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { httpTransport } from "../src/index.js";
import { reactNativeTransport } from "../src/transports/react-native.js";

describe("httpTransport", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts records as { records: [...] } JSON body", async () => {
    const t = httpTransport({ url: "http://x/api/track", headers: { "x-test": "1" } });
    await t.send([
      { kind: "event", row: stubEventRow() },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    const call = (fetch as any).mock.calls[0];
    expect(call[0]).toBe("http://x/api/track");
    expect(call[1].headers["x-test"]).toBe("1");
    const body = JSON.parse(call[1].body);
    expect(body.records).toHaveLength(1);
    expect(body.records[0].kind).toBe("event");
  });

  it("throws on non-2xx by default", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    const t = httpTransport({ url: "http://x" });
    await expect(t.send([{ kind: "event", row: stubEventRow() }])).rejects.toThrow(/500/);
  });

  it("calls onError instead of throwing when provided", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    const onError = vi.fn();
    const t = httpTransport({ url: "http://x", onError });
    await t.send([{ kind: "event", row: stubEventRow() }]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("noop on empty array", async () => {
    const t = httpTransport({ url: "http://x" });
    await t.send([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("reactNativeTransport", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to URL with auth headers", async () => {
    const t = reactNativeTransport({
      url: "http://x/api/track",
      headers: { authorization: "Bearer token" },
    });
    await t.send([{ kind: "event", row: stubEventRow() }]);
    const call = (fetch as any).mock.calls[0];
    expect(call[1].headers.authorization).toBe("Bearer token");
  });

  it("persists records to AsyncStorage on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    const store = new Map<string, string>();
    const storage = {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
    };
    const t = reactNativeTransport({ url: "http://x", storage });
    await t.send([{ kind: "event", row: stubEventRow() }]);
    const persisted = store.get("bqa.q");
    expect(persisted).toBeDefined();
    const parsed = JSON.parse(persisted!);
    expect(parsed).toHaveLength(1);
  });

  it("retries persisted records on next instantiation", async () => {
    const store = new Map<string, string>();
    store.set("bqa.q", JSON.stringify([{ kind: "event", row: stubEventRow() }]));
    const storage = {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
    };
    reactNativeTransport({ url: "http://x", storage });
    // Yield to allow retryStored() microtask
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(fetch).toHaveBeenCalled();
  });
});

function stubEventRow() {
  return {
    event_id: "evt-1",
    ts: new Date().toISOString(),
    event_name: "test",
    user_id: "u",
    anonymous_id: null,
    session_id: null,
    properties: "{}",
  };
}
