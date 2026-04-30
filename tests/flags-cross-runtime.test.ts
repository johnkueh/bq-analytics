import { describe, expect, it } from "vitest";
import { Flags, httpSource } from "../src/index.js";
import { createFlagsRoute } from "../src/handlers/next-flags.js";
import type { FlagMap, FlagSource } from "../src/index.js";

function memorySource(initial: FlagMap): FlagSource & { setFlags: (m: FlagMap) => void } {
  let current = initial;
  return {
    async read() {
      return current;
    },
    setFlags(m) {
      current = m;
    },
  };
}

describe("httpSource", () => {
  it("fetches and parses a flat flags object", async () => {
    const fetcher = (async (_url: string) =>
      new Response(JSON.stringify({ foo: { on: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const src = httpSource({ url: "http://x/api/flags", fetcher });
    const flags = await src.read();
    expect(flags).toEqual({ foo: { on: true } });
  });

  it("unwraps a { flags: {...} } envelope", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ flags: { foo: { on: true } } }), {
        status: 200,
      })) as unknown as typeof fetch;

    const src = httpSource({ url: "http://x", fetcher });
    expect(await src.read()).toEqual({ foo: { on: true } });
  });

  it("forwards custom headers", async () => {
    let receivedAuth: string | null = null;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      receivedAuth = (init?.headers as Record<string, string>).authorization ?? null;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const src = httpSource({
      url: "http://x",
      fetcher,
      headers: { authorization: "Bearer t" },
    });
    await src.read();
    expect(receivedAuth).toBe("Bearer t");
  });

  it("throws on non-2xx", async () => {
    const fetcher = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const src = httpSource({ url: "http://x", fetcher });
    await expect(src.read()).rejects.toThrow(/500/);
  });

  it("works through the Flags class (allowlist + rollout 0)", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ foo: { on: true, rollout: 0, users: ["u_a"] } }), {
        status: 200,
      })) as unknown as typeof fetch;

    const flags = new Flags({
      source: httpSource({ url: "http://x", fetcher }),
    });
    await flags.ready();
    expect(flags.isOn("foo", "u_a")).toBe(true);
    expect(flags.isOn("foo", "u_b")).toBe(false);
  });
});

describe("createFlagsRoute", () => {
  it("returns 200 with flag map when no auth configured", async () => {
    const route = createFlagsRoute({
      source: memorySource({ foo: { on: true } }),
    });
    const res = await route(new Request("http://x/api/flags"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: FlagMap };
    expect(body.flags).toEqual({ foo: { on: true } });
  });

  it("rejects unauthenticated requests when resolveUser is set", async () => {
    const route = createFlagsRoute({
      source: memorySource({}),
      resolveUser: () => null,
    });
    const res = await route(new Request("http://x/api/flags"));
    expect(res.status).toBe(401);
  });

  it("allows authenticated requests", async () => {
    const route = createFlagsRoute({
      source: memorySource({ foo: { on: true } }),
      resolveUser: () => "u1",
    });
    const res = await route(new Request("http://x/api/flags"));
    expect(res.status).toBe(200);
  });

  it("apiKey bypass skips resolveUser", async () => {
    const route = createFlagsRoute({
      source: memorySource({ foo: { on: true } }),
      resolveUser: () => null, // would reject
      apiKey: "secret",
    });
    const res = await route(
      new Request("http://x/api/flags", { headers: { "x-api-key": "secret" } }),
    );
    expect(res.status).toBe(200);
  });

  it("filter() can strip allowlists before responding", async () => {
    const route = createFlagsRoute({
      source: memorySource({ foo: { on: true, users: ["u_secret"] } }),
      filter: (flags) =>
        Object.fromEntries(
          Object.entries(flags).map(([k, v]) => [k, { ...v, users: undefined }]),
        ),
    });
    const res = await route(new Request("http://x/api/flags"));
    const body = (await res.json()) as { flags: FlagMap };
    expect(body.flags.foo!.users).toBeUndefined();
    expect(body.flags.foo!.on).toBe(true);
  });

  it("returns 502 when source read fails", async () => {
    const route = createFlagsRoute({
      source: {
        async read() {
          throw new Error("boom");
        },
      },
    });
    const res = await route(new Request("http://x/api/flags"));
    expect(res.status).toBe(502);
  });

  it("end-to-end: createFlagsRoute → httpSource → Flags", async () => {
    const route = createFlagsRoute({
      source: memorySource({
        "new-checkout": { on: true, rollout: 1 },
        "kill-old": { on: false },
      }),
    });

    // Use the route as the fetcher for httpSource
    const fetcher = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      return route(new Request(url));
    }) as unknown as typeof fetch;

    const flags = new Flags({
      source: httpSource({ url: "http://x/api/flags", fetcher }),
    });
    await flags.ready();
    expect(flags.isOn("new-checkout", "u1")).toBe(true);
    expect(flags.isOn("kill-old", "u1")).toBe(false);
  });
});
