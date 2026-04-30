import { describe, expect, it, beforeEach } from "vitest";
import { Analytics, Flags, type FlagMap, type FlagSource } from "../src/index.js";
import type { BufferedRecord, Transport } from "../src/types.js";

function makeMockTransport() {
  const sent: BufferedRecord[][] = [];
  const transport: Transport = {
    async send(records) {
      sent.push(records);
    },
  };
  return { transport, sent };
}

function exposures(sent: BufferedRecord[][]) {
  return sent
    .flat()
    .filter((r) => r.kind === "event")
    .map((r) => {
      if (r.kind !== "event") throw new Error("unreachable");
      return { ...r.row, properties: JSON.parse(r.row.properties) };
    });
}

function mockSource(initial: FlagMap): FlagSource & { setFlags: (m: FlagMap) => void } {
  let current = initial;
  return {
    async read() {
      return current;
    },
    setFlags(m: FlagMap) {
      current = m;
    },
  };
}

describe("Flags", () => {
  let mock: ReturnType<typeof makeMockTransport>;
  let analytics: Analytics;

  beforeEach(() => {
    mock = makeMockTransport();
    analytics = new Analytics({ transport: mock.transport, flushAt: 1 });
  });

  describe("inline", () => {
    it("returns false when flag is off", () => {
      const f = new Flags({ flags: { foo: { on: false } } });
      expect(f.isOn("foo", "u1")).toBe(false);
    });

    it("returns false when flag is missing", () => {
      const f = new Flags<Record<string, { on: boolean }>>({ flags: {} });
      expect(f.isOn("missing", "u1")).toBe(false);
    });

    it("returns true when on with no rollout (default 100%)", () => {
      const f = new Flags({ flags: { foo: { on: true } } });
      expect(f.isOn("foo", "u1")).toBe(true);
      expect(f.isOn("foo", "u2")).toBe(true);
    });

    it("returns false when rollout is 0", () => {
      const f = new Flags({ flags: { foo: { on: true, rollout: 0 } } });
      expect(f.isOn("foo", "u1")).toBe(false);
    });

    it("allowlist users always get true regardless of rollout", () => {
      const f = new Flags({
        flags: { foo: { on: true, rollout: 0, users: ["u_beta"] } },
      });
      expect(f.isOn("foo", "u_beta")).toBe(true);
      expect(f.isOn("foo", "u_other")).toBe(false);
    });

    it("rollout bucketing is deterministic per (userId, key)", () => {
      const a = new Flags({ flags: { foo: { on: true, rollout: 0.5 } } });
      const b = new Flags({ flags: { foo: { on: true, rollout: 0.5 } } });
      expect(a.isOn("foo", "u1")).toBe(b.isOn("foo", "u1"));
      expect(a.isOn("foo", "u2")).toBe(b.isOn("foo", "u2"));
    });

    it("rollout splits ~evenly across many users", () => {
      const f = new Flags({ flags: { foo: { on: true, rollout: 0.5 } } });
      let on = 0;
      for (let i = 0; i < 1000; i++) if (f.isOn("foo", `u${i}`)) on++;
      expect(on).toBeGreaterThan(400);
      expect(on).toBeLessThan(600);
    });
  });

  describe("exposure tracking", () => {
    it("emits exposure event with key + on through analytics", async () => {
      const f = new Flags({ flags: { foo: { on: true } }, analytics });
      f.isOn("foo", "u1");
      await analytics.flush();
      const ev = exposures(mock.sent);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.event_name).toBe("$flag_called");
      expect(ev[0]!.user_id).toBe("u1");
      expect(ev[0]!.properties).toEqual({ key: "foo", on: true });
    });

    it("dedupes first exposure per (key, userId, on) within the process", async () => {
      const f = new Flags({ flags: { foo: { on: true } }, analytics });
      f.isOn("foo", "u1");
      f.isOn("foo", "u1");
      f.isOn("foo", "u1");
      await analytics.flush();
      expect(exposures(mock.sent)).toHaveLength(1);
    });

    it("emits a separate exposure for a different user", async () => {
      const f = new Flags({ flags: { foo: { on: true } }, analytics });
      f.isOn("foo", "u1");
      f.isOn("foo", "u2");
      await analytics.flush();
      expect(exposures(mock.sent)).toHaveLength(2);
    });

    it("respects custom exposureEvent name", async () => {
      const f = new Flags({
        flags: { foo: { on: true } },
        analytics,
        exposureEvent: "flag.evaluated",
      });
      f.isOn("foo", "u1");
      await analytics.flush();
      expect(exposures(mock.sent)[0]!.event_name).toBe("flag.evaluated");
    });

    it("does not emit when analytics is not provided", () => {
      const f = new Flags({ flags: { foo: { on: true } } });
      expect(() => f.isOn("foo", "u1")).not.toThrow();
    });
  });

  describe("source", () => {
    it("loads flags from source on ready()", async () => {
      const src = mockSource({ foo: { on: true } });
      const f = new Flags({ source: src });
      await f.ready();
      expect(f.isOn("foo", "u1")).toBe(true);
    });

    it("returns false for any flag before ready() resolves", () => {
      const src = mockSource({ foo: { on: true } });
      const f = new Flags({ source: src });
      expect(f.isOn("foo", "u1")).toBe(false);
    });

    it("refresh() picks up new flags", async () => {
      const src = mockSource({ foo: { on: false } });
      const f = new Flags({ source: src });
      await f.ready();
      expect(f.isOn("foo", "u1")).toBe(false);

      src.setFlags({ foo: { on: true } });
      await f.refresh();
      expect(f.isOn("foo", "u1")).toBe(true);
    });

    it("ready() is a no-op when no source is configured", async () => {
      const f = new Flags({ flags: { foo: { on: true } } });
      await expect(f.ready()).resolves.toBeUndefined();
    });

    it("close() stops auto-refresh timer", async () => {
      const src = mockSource({ foo: { on: true } });
      const f = new Flags({ source: src, refreshIntervalMs: 10_000 });
      await f.ready();
      f.close();
      // Just verifying no throw — timer cleanup
      expect(f.isOn("foo", "u1")).toBe(true);
    });
  });
});
