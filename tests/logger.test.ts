import { describe, expect, it, beforeEach, vi } from "vitest";
import { Analytics } from "../src/index.js";
import { createLogger } from "../src/logger.js";
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

describe("createLogger", () => {
  let mock: ReturnType<typeof makeMockTransport>;
  let a: Analytics;

  beforeEach(() => {
    mock = makeMockTransport();
    a = new Analytics({ transport: mock.transport });
  });

  it("info/warn/error each emit a log row with the right level", async () => {
    const logger = createLogger(a, { stdout: false });
    logger.info("hello info", { x: 1 });
    logger.warn("hello warn", { y: 2 });
    logger.error("hello error", { z: 3 });
    await a.flush();
    const rows = mock.sent[0]!;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => (r.kind === "log" ? r.row.level : null))).toEqual([
      "info",
      "warn",
      "error",
    ]);
    expect(rows.map((r) => (r.kind === "log" ? r.row.message : null))).toEqual([
      "hello info",
      "hello warn",
      "hello error",
    ]);
  });

  it("defaults source to 'app' and respects override", async () => {
    const a2 = new Analytics({ transport: mock.transport });
    const def = createLogger(a, { stdout: false });
    const lam = createLogger(a2, { stdout: false, source: "lambda" });
    def.info("default");
    lam.info("custom");
    await Promise.all([a.flush(), a2.flush()]);
    const sources = mock.sent
      .flat()
      .map((r) => (r.kind === "log" ? r.row.source : null));
    expect(sources).toEqual(["app", "lambda"]);
  });

  it("coerces an Error into { err, stack } fields", async () => {
    const logger = createLogger(a, { stdout: false });
    const boom = new Error("nope");
    logger.error("explosion", boom);
    await a.flush();
    const rec = mock.sent[0]![0]!;
    expect(rec.kind).toBe("log");
    if (rec.kind === "log") {
      const fields = JSON.parse(rec.row.fields);
      expect(fields.err).toBe("nope");
      expect(typeof fields.stack).toBe("string");
    }
  });

  it("coerces unknown / primitive into { value }", async () => {
    const logger = createLogger(a, { stdout: false });
    logger.warn("rejected", "string-reason");
    logger.warn("rejected number", 42);
    await a.flush();
    const fieldsList = mock.sent[0]!.map((r) =>
      r.kind === "log" ? JSON.parse(r.row.fields) : null,
    );
    expect(fieldsList[0]).toEqual({ value: "string-reason" });
    expect(fieldsList[1]).toEqual({ value: "42" });
  });

  it("accepts a thunk resolver and re-resolves per call", async () => {
    let counter = 0;
    const resolver = () => {
      counter++;
      return a;
    };
    const logger = createLogger(resolver, { stdout: false });
    logger.info("one");
    logger.info("two");
    expect(counter).toBe(2);
    await a.flush();
    expect(mock.sent[0]).toHaveLength(2);
  });

  it("never throws when analytics throws", () => {
    const broken = () => {
      throw new Error("boom");
    };
    const logger = createLogger(broken as never, { stdout: false });
    expect(() => logger.info("safe")).not.toThrow();
  });

  it("writes to stdout when stdout:true (default)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger(a);
    logger.info("hello", { x: 1 });
    expect(spy).toHaveBeenCalledWith("hello", { x: 1 });
    spy.mockRestore();
  });

  it("skips stdout when stdout:false", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger(a, { stdout: false });
    logger.info("silent");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
