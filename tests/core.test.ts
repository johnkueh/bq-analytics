import { describe, expect, it, beforeEach } from "vitest";
import { Analytics, withScope } from "../src/index.js";
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

describe("Analytics core", () => {
  let mock: ReturnType<typeof makeMockTransport>;
  let a: Analytics;

  beforeEach(() => {
    mock = makeMockTransport();
    a = new Analytics({ transport: mock.transport });
  });

  it("track() buffers an event row with required fields", () => {
    a.track("translation.started", { videoId: "abc" }, { userId: "u1" });
    expect(a.size()).toBe(1);
  });

  it("track() with no attrs leaves user_id null", async () => {
    a.track("pageview", { path: "/" });
    await a.flush();
    const records = mock.sent[0]!;
    expect(records).toHaveLength(1);
    expect(records[0]!.kind).toBe("event");
    if (records[0]!.kind === "event") {
      expect(records[0]!.row.user_id).toBeNull();
      expect(records[0]!.row.event_name).toBe("pageview");
      expect(records[0]!.row.properties).toBe(JSON.stringify({ path: "/" }));
    }
  });

  it("track() generates a unique event_id per call", async () => {
    a.track("e", {}, { userId: "u" });
    a.track("e", {}, { userId: "u" });
    await a.flush();
    const ids = mock.sent[0]!.flatMap((r) => (r.kind === "event" ? [r.row.event_id] : []));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("identify() requires userId", () => {
    expect(() => a.identify("", {})).toThrow(/userId is required/);
  });

  it("identify() serializes traits to JSON string", async () => {
    a.identify("u1", { plan: "pro", credits: 47, is_active: true });
    await a.flush();
    const r = mock.sent[0]![0]!;
    expect(r.kind).toBe("identify");
    if (r.kind === "identify") {
      expect(JSON.parse(r.row.traits)).toEqual({ plan: "pro", credits: 47, is_active: true });
    }
  });

  it("group() requires both type and id", () => {
    expect(() => a.group("", "g1")).toThrow();
    expect(() => a.group("household", "")).toThrow();
  });

  it("group() with userId emits both group and user_group rows", async () => {
    a.group("household", "h1", { size: 4 }, "u1");
    await a.flush();
    const records = mock.sent[0]!;
    expect(records.map((r) => r.kind)).toEqual(["group", "user_group"]);
  });

  it("group() without userId emits only group row", async () => {
    a.group("household", "h1", { size: 4 });
    await a.flush();
    const records = mock.sent[0]!;
    expect(records.map((r) => r.kind)).toEqual(["group"]);
  });

  it("log() captures level + fields", async () => {
    a.log("error", "boom", { request_id: "r1" }, "api");
    await a.flush();
    const r = mock.sent[0]![0]!;
    expect(r.kind).toBe("log");
    if (r.kind === "log") {
      expect(r.row.level).toBe("error");
      expect(r.row.source).toBe("api");
      expect(r.row.message).toBe("boom");
      expect(JSON.parse(r.row.fields)).toEqual({ request_id: "r1" });
    }
  });

  it("flush() drains buffer and is a no-op when empty", async () => {
    await a.flush();
    expect(mock.sent).toHaveLength(0);
    a.track("x", {}, { userId: "u" });
    await a.flush();
    await a.flush();
    expect(mock.sent).toHaveLength(1);
    expect(a.size()).toBe(0);
  });

  it("flush() restores buffer if transport throws", async () => {
    const bad = new Analytics({
      transport: { async send() { throw new Error("nope"); } },
    });
    bad.track("e", {}, { userId: "u" });
    await expect(bad.flush()).rejects.toThrow("nope");
    expect(bad.size()).toBe(1);
  });

  it("auto-flushes once flushAt is reached", async () => {
    const a2 = new Analytics({ transport: mock.transport, flushAt: 3 });
    a2.track("a", {}, { userId: "u" });
    a2.track("b", {}, { userId: "u" });
    expect(mock.sent).toHaveLength(0);
    a2.track("c", {}, { userId: "u" });
    // auto-flush is fire-and-forget; drain microtasks
    await new Promise((r) => setImmediate(r));
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]).toHaveLength(3);
  });

  it("ts is a valid ISO-8601 string", async () => {
    a.track("e", {}, { userId: "u" });
    await a.flush();
    const r = mock.sent[0]![0]!;
    if (r.kind === "event") {
      expect(() => new Date(r.row.ts).toISOString()).not.toThrow();
      expect(r.row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("anonymous_id and session_id are preserved", async () => {
    a.track("e", {}, { anonymousId: "anon-1", sessionId: "sess-1" });
    await a.flush();
    const r = mock.sent[0]![0]!;
    if (r.kind === "event") {
      expect(r.row.anonymous_id).toBe("anon-1");
      expect(r.row.session_id).toBe("sess-1");
      expect(r.row.user_id).toBeNull();
    }
  });

  it("feedback() requires a non-empty message", () => {
    expect(() => a.feedback({} as never)).toThrow(/message is required/);
    expect(() => a.feedback({ message: "" })).toThrow(/message is required/);
  });

  it("feedback() defaults kind to 'general' and stamps required fields", async () => {
    a.feedback({ message: "love this" }, { userId: "u1", sessionId: "s1" });
    await a.flush();
    const r = mock.sent[0]![0]!;
    expect(r.kind).toBe("feedback");
    if (r.kind === "feedback") {
      expect(r.row.kind).toBe("general");
      expect(r.row.message).toBe("love this");
      expect(r.row.user_id).toBe("u1");
      expect(r.row.session_id).toBe("s1");
      expect(r.row.subject).toBeNull();
      expect(r.row.severity).toBeNull();
      expect(r.row.url).toBeNull();
      expect(r.row.feedback_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(JSON.parse(r.row.properties)).toEqual({});
    }
  });

  it("feedback() carries kind, subject, severity, url, properties", async () => {
    a.feedback(
      {
        kind: "bug",
        subject: "Translate button does nothing",
        message: "On iOS 17 the translate button is unresponsive after upload.",
        severity: "high",
        url: "/translate",
        properties: { app_version: "1.4.2", platform: "ios" },
      },
      { userId: "u-bug" },
    );
    await a.flush();
    const r = mock.sent[0]![0]!;
    if (r.kind === "feedback") {
      expect(r.row.kind).toBe("bug");
      expect(r.row.subject).toBe("Translate button does nothing");
      expect(r.row.severity).toBe("high");
      expect(r.row.url).toBe("/translate");
      expect(JSON.parse(r.row.properties)).toEqual({ app_version: "1.4.2", platform: "ios" });
    }
  });

  it("feedback() generates unique ids per submission", async () => {
    a.feedback({ message: "one" });
    a.feedback({ message: "two" });
    await a.flush();
    const ids = mock.sent[0]!.flatMap((r) => (r.kind === "feedback" ? [r.row.feedback_id] : []));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("scope().end() emits one log row with accumulated fields", async () => {
    const scope = a.scope({ source: "process", fields: { pendingId: "p1" } });
    scope.set({ sourceType: "url" });
    scope.set({ cacheChecked: true, recipeId: "r1" });
    scope.end({ outcome: "success" });
    await a.flush();
    const r = mock.sent[0]![0]!;
    expect(r.kind).toBe("log");
    if (r.kind === "log") {
      expect(r.row.level).toBe("info");
      expect(r.row.source).toBe("process");
      expect(r.row.message).toBe("scope");
      const fields = JSON.parse(r.row.fields);
      expect(fields.pendingId).toBe("p1");
      expect(fields.sourceType).toBe("url");
      expect(fields.cacheChecked).toBe(true);
      expect(fields.recipeId).toBe("r1");
      expect(fields.outcome).toBe("success");
      expect(typeof fields.duration_ms).toBe("number");
    }
  });

  it("scope().end() is idempotent", async () => {
    const scope = a.scope({ source: "x" });
    scope.end();
    scope.end();
    scope.end();
    await a.flush();
    expect(mock.sent[0]).toHaveLength(1);
  });

  it("scope().error() promotes level and stamps error fields", async () => {
    const scope = a.scope({ source: "process" });
    scope.set({ pendingId: "p1" });
    scope.error(new Error("upstream 503"), { step: "fetch" });
    scope.end();
    await a.flush();
    const r = mock.sent[0]![0]!;
    if (r.kind === "log") {
      expect(r.row.level).toBe("error");
      const fields = JSON.parse(r.row.fields);
      expect(fields.pendingId).toBe("p1");
      expect(fields.step).toBe("fetch");
      expect(fields.error_message).toBe("upstream 503");
      expect(fields.error_stack).toMatch(/Error: upstream 503/);
    }
  });

  it("scope().error() handles non-Error throwables", async () => {
    const scope = a.scope({ source: "x" });
    scope.error("plain string");
    scope.end();
    await a.flush();
    const r = mock.sent[0]![0]!;
    if (r.kind === "log") {
      const fields = JSON.parse(r.row.fields);
      expect(fields.error_message).toBe("plain string");
      expect(fields.error_stack).toBeNull();
    }
  });

  it("withScope() ends on success and returns the value", async () => {
    const result = await withScope(a, { source: "process" }, async (scope) => {
      scope.set({ step: "done" });
      return 42;
    });
    expect(result).toBe(42);
    await a.flush();
    const r = mock.sent[0]![0]!;
    if (r.kind === "log") {
      expect(r.row.level).toBe("info");
      expect(JSON.parse(r.row.fields).step).toBe("done");
    }
  });

  it("withScope() rethrows but ends with error level", async () => {
    await expect(
      withScope(a, { source: "process" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await a.flush();
    const r = mock.sent[0]![0]!;
    if (r.kind === "log") {
      expect(r.row.level).toBe("error");
      expect(JSON.parse(r.row.fields).error_message).toBe("boom");
    }
  });
});
