import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Analytics } from "../src/index.js";
import { attachCliHooks } from "../src/cli/attach.js";
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

describe("attachCliHooks", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let detach: () => void;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as never);
  });

  afterEach(() => {
    if (detach) detach();
    exitSpy.mockRestore();
  });

  it("registers and detaches handlers cleanly", () => {
    const before = process.listenerCount("uncaughtException");
    const a = new Analytics({ transport: makeMockTransport().transport });
    detach = attachCliHooks(a, { source: "test", exitOnSignal: false });
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);
    detach();
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });

  it("logs uncaughtException + flushes + exits 1", async () => {
    const mock = makeMockTransport();
    const a = new Analytics({ transport: mock.transport });
    detach = attachCliHooks(a, { source: "test", exitOnSignal: false });

    const handler = process.listeners("uncaughtException").at(-1) as (e: Error) => void;
    expect(() => handler(new Error("boom"))).not.toThrow();

    // wait for the flush + exit microtask chain
    await new Promise((r) => setTimeout(r, 50));

    expect(mock.sent.length).toBeGreaterThan(0);
    const log = mock.sent[0]!.find((r) => r.kind === "log");
    expect(log).toBeDefined();
    if (log?.kind === "log") {
      expect(log.row.message).toBe("boom");
      expect(log.row.level).toBe("error");
      const fields = JSON.parse(log.row.fields);
      expect(fields.kind).toBe("uncaught_exception");
      expect(fields.fatal).toBe(true);
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("logs unhandledRejection without exiting", async () => {
    const mock = makeMockTransport();
    const a = new Analytics({ transport: mock.transport });
    detach = attachCliHooks(a, { source: "test", exitOnSignal: false });

    const handler = process.listeners("unhandledRejection").at(-1) as (r: unknown) => void;
    handler(new Error("nope"));

    await new Promise((r) => setTimeout(r, 50));
    expect(exitSpy).not.toHaveBeenCalled();
    const log = mock.sent[0]?.find((r) => r.kind === "log");
    expect(log?.kind).toBe("log");
    if (log?.kind === "log") {
      expect(JSON.parse(log.row.fields).kind).toBe("unhandled_rejection");
    }
  });
});
