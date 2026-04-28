import { describe, expect, it } from "vitest";
import pino from "pino";
import { Analytics } from "../src/index.js";
import { pinoBqTransport } from "../src/transports/pino.js";
import type { BufferedRecord, Transport } from "../src/types.js";

function makeMockTransport() {
  const sent: BufferedRecord[][] = [];
  return {
    sent,
    transport: {
      async send(records: BufferedRecord[]) {
        sent.push(records);
      },
    } satisfies Transport,
  };
}

describe("pinoBqTransport", () => {
  it("forwards a pino info line into Analytics.log", async () => {
    const mock = makeMockTransport();
    const a = new Analytics({ transport: mock.transport });
    const dest = pinoBqTransport({ projectId: "x", analytics: a, source: "test" });
    const logger = pino({ level: "debug" }, dest);

    logger.info({ requestId: "r1" }, "hello");
    logger.warn({ retry: 2 }, "soft fail");
    logger.error("boom");

    // Pino writes are sync-ish, but give event loop a tick
    await new Promise((r) => setImmediate(r));
    await a.flush();

    const records = mock.sent.flat();
    expect(records).toHaveLength(3);
    expect(records.every((r) => r.kind === "log")).toBe(true);

    const messages = records.flatMap((r) => (r.kind === "log" ? [r.row.message] : []));
    const levels = records.flatMap((r) => (r.kind === "log" ? [r.row.level] : []));
    expect(messages).toEqual(["hello", "soft fail", "boom"]);
    expect(levels).toEqual(["info", "warn", "error"]);

    const firstFields = records[0]!.kind === "log" ? JSON.parse(records[0]!.row.fields) : {};
    expect(firstFields.requestId).toBe("r1");
    expect(records[0]!.kind === "log" && records[0]!.row.source).toBe("test");
  });

  it("normalises pino levels to debug/info/warn/error", async () => {
    const mock = makeMockTransport();
    const a = new Analytics({ transport: mock.transport });
    const dest = pinoBqTransport({ projectId: "x", analytics: a });
    const logger = pino({ level: "trace" }, dest);

    logger.trace("t");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.fatal("f");

    await new Promise((r) => setImmediate(r));
    await a.flush();

    const levels = mock.sent.flat().flatMap((r) => (r.kind === "log" ? [r.row.level] : []));
    expect(levels).toEqual(["debug", "debug", "info", "warn", "error", "error"]);
  });
});
