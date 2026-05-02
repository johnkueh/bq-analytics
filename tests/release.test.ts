import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  // schema + validator
  isReleaseConfig,
  DEFAULT_RELEASE_CONFIG,
  RELEASE_KEY,
  // gate
  evaluateGate,
  // store-url
  resolveAppStoreUrl,
  openAppStore,
  // events
  RELEASE_EVENTS,
  // async storage keys
  HAS_LAUNCHED_KEY,
  LAST_SEEN_KEY,
  RELEASE_CACHE_KEY,
  type ReleaseConfig,
  type ReleaseGate,
} from "../src/release/index.js";

import { Config, type ConfigSource } from "../src/config/index.js";
import { httpConfigSource } from "../src/config/http.js";
import { createReleaseConfigRoute } from "../src/handlers/next-release.js";

// ---------------------------------------------------------------------------
// schema validator
// ---------------------------------------------------------------------------

describe("isReleaseConfig", () => {
  const valid: ReleaseConfig = {
    gate: { minIosBuild: 0, minAndroidBuild: 0, hardBlock: false },
    whatsNew: null,
  };

  it("accepts the no-op default", () => {
    expect(isReleaseConfig(valid)).toBe(true);
  });

  it("accepts extra fields (permissive — server can extend the schema)", () => {
    expect(
      isReleaseConfig({
        ...valid,
        someFutureField: { foo: "bar" },
        announcement: "ignored by old clients",
      }),
    ).toBe(true);
  });

  it("rejects null / non-object", () => {
    expect(isReleaseConfig(null)).toBe(false);
    expect(isReleaseConfig(undefined)).toBe(false);
    expect(isReleaseConfig("string")).toBe(false);
    expect(isReleaseConfig(42)).toBe(false);
  });

  it("rejects missing gate", () => {
    expect(isReleaseConfig({ whatsNew: null })).toBe(false);
  });

  it("rejects malformed gate fields", () => {
    expect(
      isReleaseConfig({
        gate: { minIosBuild: "1", minAndroidBuild: 0, hardBlock: false },
      }),
    ).toBe(false);
    expect(
      isReleaseConfig({
        gate: { minIosBuild: 0, minAndroidBuild: 0, hardBlock: "yes" },
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateGate
// ---------------------------------------------------------------------------

describe("evaluateGate", () => {
  const offGate: ReleaseGate = { minIosBuild: 0, minAndroidBuild: 0, hardBlock: false };
  const softGate: ReleaseGate = { minIosBuild: 5, minAndroidBuild: 5, hardBlock: false };
  const hardGate: ReleaseGate = { minIosBuild: 5, minAndroidBuild: 5, hardBlock: true };

  it("returns 'ok' when min === 0 (gate disabled)", () => {
    expect(evaluateGate({ gate: offGate, currentBuild: 1, platform: "ios" })).toBe("ok");
    expect(evaluateGate({ gate: offGate, currentBuild: null, platform: "ios" })).toBe("ok");
  });

  it("returns 'ok' when current >= min", () => {
    expect(evaluateGate({ gate: softGate, currentBuild: 5, platform: "ios" })).toBe("ok");
    expect(evaluateGate({ gate: softGate, currentBuild: 999, platform: "ios" })).toBe("ok");
  });

  it("returns 'soft' when current < min and !hardBlock", () => {
    expect(evaluateGate({ gate: softGate, currentBuild: 4, platform: "ios" })).toBe("soft");
    expect(evaluateGate({ gate: softGate, currentBuild: 4, platform: "android" })).toBe("soft");
  });

  it("returns 'hard' when current < min and hardBlock", () => {
    expect(evaluateGate({ gate: hardGate, currentBuild: 4, platform: "ios" })).toBe("hard");
  });

  it("fails open in prod when currentBuild is null", () => {
    expect(evaluateGate({ gate: hardGate, currentBuild: null, platform: "ios" })).toBe("ok");
    expect(evaluateGate({ gate: hardGate, currentBuild: NaN, platform: "ios" })).toBe("ok");
  });

  it("uses fallbackInDev when in dev mode and currentBuild is null", () => {
    // dev fallback below the floor → behaves like a real low build
    expect(
      evaluateGate({
        gate: hardGate,
        currentBuild: null,
        platform: "ios",
        isDev: true,
        fallbackInDev: 1,
      }),
    ).toBe("hard");
    expect(
      evaluateGate({
        gate: softGate,
        currentBuild: null,
        platform: "ios",
        isDev: true,
        fallbackInDev: 1,
      }),
    ).toBe("soft");
  });

  it("ignores fallbackInDev in production semantics (isDev not set)", () => {
    expect(
      evaluateGate({
        gate: hardGate,
        currentBuild: null,
        platform: "ios",
        fallbackInDev: 1,
      }),
    ).toBe("ok");
  });

  it("returns 'ok' when fallbackInDev is 0 (fail-open in dev too)", () => {
    expect(
      evaluateGate({
        gate: hardGate,
        currentBuild: null,
        platform: "ios",
        isDev: true,
        fallbackInDev: 0,
      }),
    ).toBe("ok");
  });

  it("picks the per-platform floor", () => {
    const split: ReleaseGate = { minIosBuild: 5, minAndroidBuild: 10, hardBlock: false };
    expect(evaluateGate({ gate: split, currentBuild: 6, platform: "ios" })).toBe("ok");
    expect(evaluateGate({ gate: split, currentBuild: 6, platform: "android" })).toBe("soft");
  });
});

// ---------------------------------------------------------------------------
// Config<T>
// ---------------------------------------------------------------------------

describe("Config<T>", () => {
  function makeSource<T>(initial: T | null) {
    let current = initial;
    const source: ConfigSource<T> & { setValue: (v: T | null) => void } = {
      async read() {
        return current;
      },
      setValue(v) {
        current = v;
      },
    };
    return source;
  }

  it("returns the default value before the first read lands", () => {
    const slow = makeSource<{ n: number }>(null);
    const config = new Config({ source: slow, defaultValue: { n: 0 } });
    expect(config.current()).toEqual({ n: 0 });
  });

  it("replaces cache after a successful refresh", async () => {
    const source = makeSource<{ n: number }>({ n: 1 });
    const config = new Config({ source, defaultValue: { n: 0 } });
    await config.ready();
    expect(config.current()).toEqual({ n: 1 });
  });

  it("keeps the previous value when the source returns null", async () => {
    const source = makeSource<{ n: number }>({ n: 1 });
    const config = new Config({ source, defaultValue: { n: 0 } });
    await config.ready();
    source.setValue(null);
    await config.refresh();
    expect(config.current()).toEqual({ n: 1 });
  });

  it("fires onChange after every successful read", async () => {
    const source = makeSource<{ n: number }>({ n: 1 });
    const seen: { n: number }[] = [];
    const config = new Config({
      source,
      defaultValue: { n: 0 },
      onChange: (v) => seen.push(v),
    });
    await config.ready();
    source.setValue({ n: 2 });
    await config.refresh();
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("destroy() cancels the refresh timer", async () => {
    vi.useFakeTimers();
    const source = makeSource<{ n: number }>({ n: 1 });
    const reads = vi.spyOn(source, "read");
    const config = new Config({ source, defaultValue: { n: 0 }, refreshIntervalMs: 1000 });
    await config.ready();
    reads.mockClear();

    config.destroy();
    vi.advanceTimersByTime(5000);
    expect(reads).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// httpConfigSource
// ---------------------------------------------------------------------------

describe("httpConfigSource", () => {
  it("returns parsed JSON when the validator passes", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ n: 1 }), { status: 200 }),
    );
    const source = httpConfigSource<{ n: number }>({
      url: "https://example.test/x",
      validator: (v): v is { n: number } => !!v && typeof (v as { n: unknown }).n === "number",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(await source.read()).toEqual({ n: 1 });
  });

  it("returns null when the validator rejects the body", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ wrong: "shape" }), { status: 200 }),
    );
    const source = httpConfigSource<{ n: number }>({
      url: "https://example.test/x",
      validator: (v): v is { n: number } => !!v && typeof (v as { n: unknown }).n === "number",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(await source.read()).toBeNull();
  });

  it("returns null on non-2xx", async () => {
    const fetcher = vi.fn(async () => new Response("nope", { status: 500 }));
    const source = httpConfigSource<{ n: number }>({
      url: "https://example.test/x",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(await source.read()).toBeNull();
  });

  it("returns null on fetch error / abort", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network");
    });
    const source = httpConfigSource<{ n: number }>({
      url: "https://example.test/x",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(await source.read()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// store-url resolution
// ---------------------------------------------------------------------------

describe("resolveAppStoreUrl", () => {
  const ids = { iosAppId: "12345", androidPackage: "com.example.app" };

  it("falls back to public store schemes for production with no overrides", () => {
    expect(resolveAppStoreUrl({ ...ids, platform: "ios", channel: "production" })).toBe(
      "itms-apps://itunes.apple.com/app/id12345",
    );
    expect(resolveAppStoreUrl({ ...ids, platform: "android", channel: "production" })).toBe(
      "market://details?id=com.example.app",
    );
  });

  it("uses the per-channel override when set", () => {
    const urls = {
      preview: { ios: "itms-beta://beta.itunes.apple.com/v1/app/12345" },
    };
    expect(
      resolveAppStoreUrl({ ...ids, platform: "ios", channel: "preview", urls }),
    ).toBe("itms-beta://beta.itunes.apple.com/v1/app/12345");
  });

  it("falls back to the production default when channel has no override", () => {
    const urls = { production: { ios: "itms-apps://override" } };
    expect(
      resolveAppStoreUrl({ ...ids, platform: "ios", channel: "development", urls }),
    ).toBe("itms-apps://itunes.apple.com/app/id12345");
  });
});

describe("openAppStore", () => {
  const ids = { iosAppId: "12345", androidPackage: "com.example.app" };

  it("calls openUrl with the resolved URL", async () => {
    const opens: string[] = [];
    await openAppStore({
      ...ids,
      platform: "ios",
      channel: "production",
      openUrl: async (u) => {
        opens.push(u);
      },
    });
    expect(opens).toEqual(["itms-apps://itunes.apple.com/app/id12345"]);
  });

  it("falls back to the web URL when the primary throws", async () => {
    const opens: string[] = [];
    await openAppStore({
      ...ids,
      platform: "ios",
      openUrl: async (u) => {
        opens.push(u);
        if (u.startsWith("itms-apps://")) throw new Error("no handler");
      },
    });
    expect(opens).toEqual([
      "itms-apps://itunes.apple.com/app/id12345",
      "https://apps.apple.com/app/id12345",
    ]);
  });

  it("falls back to webFallback when an explicit override fails", async () => {
    const opens: string[] = [];
    const urls = { preview: { ios: "itms-beta://does/not/work" } };
    await openAppStore({
      ...ids,
      platform: "ios",
      channel: "preview",
      urls,
      webFallback: "https://example.test/install",
      openUrl: async (u) => {
        opens.push(u);
        if (u.startsWith("itms-beta://")) throw new Error("no handler");
      },
    });
    expect(opens).toEqual([
      "itms-beta://does/not/work",
      "https://example.test/install",
    ]);
  });

  it("gives up silently when both URLs fail", async () => {
    let calls = 0;
    await openAppStore({
      ...ids,
      platform: "ios",
      openUrl: async () => {
        calls++;
        throw new Error("nope");
      },
    });
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// createReleaseConfigRoute
// ---------------------------------------------------------------------------

describe("createReleaseConfigRoute", () => {
  const valid: ReleaseConfig = {
    gate: { minIosBuild: 5, minAndroidBuild: 5, hardBlock: false },
    whatsNew: null,
  };

  it("returns the source value as JSON with default cache headers", async () => {
    const handler = createReleaseConfigRoute({
      source: { async read() { return valid; } },
    });
    const res = await handler(new Request("https://x.test/api/release-config"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    expect(await res.json()).toEqual(valid);
  });

  it("falls back to DEFAULT_RELEASE_CONFIG when the source returns null", async () => {
    const handler = createReleaseConfigRoute({
      source: { async read() { return null; } },
    });
    const res = await handler(new Request("https://x.test/api/release-config"));
    expect(await res.json()).toEqual(DEFAULT_RELEASE_CONFIG);
  });

  it("falls back to DEFAULT_RELEASE_CONFIG when the source throws", async () => {
    const errors: unknown[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args) => {
      errors.push(args);
    });
    const handler = createReleaseConfigRoute({
      source: {
        async read() {
          throw new Error("boom");
        },
      },
    });
    const res = await handler(new Request("https://x.test/api/release-config"));
    expect(await res.json()).toEqual(DEFAULT_RELEASE_CONFIG);
    expect(errors.length).toBe(1);
    warn.mockRestore();
  });

  it("respects a custom cacheControl override", async () => {
    const handler = createReleaseConfigRoute({
      source: { async read() { return valid; } },
      cacheControl: "no-store",
    });
    const res = await handler(new Request("https://x.test/api/release-config"));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

// ---------------------------------------------------------------------------
// constants — guard against silent renames that would orphan dedup state
// ---------------------------------------------------------------------------

describe("stable constants", () => {
  it("RELEASE_EVENTS event names are exactly the cross-app contract", () => {
    expect(RELEASE_EVENTS).toEqual({
      GATE_SHOWN: "update_gate.shown",
      GATE_FEEDBACK_TAPPED: "update_gate.feedback_tapped",
      NOTES_SHOWN: "whats_new.shown",
      NOTES_DISMISSED: "whats_new.dismissed",
      NOTES_UPDATE_TAPPED: "whats_new.update_tapped",
      NOTES_FEEDBACK_TAPPED: "whats_new.feedback_tapped",
      NOTES_CTA_TAPPED: "whats_new.cta_tapped",
      PENDING_UPDATE_SHOWN: "pending_update.shown",
      PENDING_UPDATE_APPLIED: "pending_update.applied",
      PENDING_UPDATE_DISMISSED: "pending_update.dismissed",
    });
  });

  it("AsyncStorage keys match the recipes.im production strings", () => {
    expect(HAS_LAUNCHED_KEY).toBe("app:has_launched");
    expect(LAST_SEEN_KEY).toBe("whatsNew:last_seen");
    expect(RELEASE_CACHE_KEY).toBe("release-config:cached");
  });

  it("RELEASE_KEY is the agreed Edge Config item key", () => {
    expect(RELEASE_KEY).toBe("release");
  });

  it("PENDING_UPDATE_DISMISSED_KEY_PREFIX matches the cross-bundle dedup contract", async () => {
    const { PENDING_UPDATE_DISMISSED_KEY_PREFIX } = await import(
      "../src/release/async-storage-keys.js"
    );
    expect(PENDING_UPDATE_DISMISSED_KEY_PREFIX).toBe(
      "pendingUpdate:dismissed:",
    );
  });
});

// ---------------------------------------------------------------------------
// Module-graph isolation: <PendingUpdatePrompt> imports `expo-updates`,
// which not every bq-analytics/release/native consumer wants to install.
// We enforce by source inspection that the main `release/native/index.ts`
// (and every other file it can transitively reach) doesn't import the
// pending-update sub-entry. Consumers who DO want OTA opt in by
// importing from `bq-analytics/release/native/pending-update`.
// ---------------------------------------------------------------------------

describe("module-graph isolation", () => {
  it("release/native (excluding pending-update files) does not import expo-updates", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = path.resolve(__dirname, "../src/release/native");
    const entries = await fs.readdir(dir);
    const filesToCheck = entries.filter(
      (f) =>
        (f.endsWith(".ts") || f.endsWith(".tsx")) &&
        !f.startsWith("pending-update"),
    );
    expect(filesToCheck.length).toBeGreaterThan(0);
    for (const file of filesToCheck) {
      const contents = await fs.readFile(path.join(dir, file), "utf8");
      expect(contents, `${file} must not import expo-updates`).not.toMatch(
        /from ["']expo-updates["']/,
      );
      expect(contents, `${file} must not require expo-updates`).not.toMatch(
        /require\(["']expo-updates["']\)/,
      );
      // Also catch cross-entry imports: nothing in the main native
      // surface should re-export from pending-update or its impl file.
      // Match real import / require / export-from statements only —
      // comments mentioning "pending-update" by name are fine.
      expect(
        contents,
        `${file} must not import pending-update transitively`,
      ).not.toMatch(
        /(?:from|require\(|export\s*\{[^}]*\}\s*from)\s*["'][^"']*pending-update[^"']*["']/,
      );
    }
  });

  it("pending-update sub-entry source exists and re-exports the prompt", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const subEntry = await fs.readFile(
      path.resolve(__dirname, "../src/release/native/pending-update.ts"),
      "utf8",
    );
    expect(subEntry).toMatch(/export\s*\{[^}]*PendingUpdatePrompt/);
    const impl = await fs.readFile(
      path.resolve(
        __dirname,
        "../src/release/native/pending-update-prompt.tsx",
      ),
      "utf8",
    );
    expect(impl).toMatch(/from ["']expo-updates["']/);
    expect(impl).toMatch(/export function PendingUpdatePrompt/);
  });
});
