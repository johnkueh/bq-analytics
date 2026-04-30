#!/usr/bin/env tsx
/**
 * Edge Config flag-source smoke. Empirically verifies the assumptions we
 * baked into the architecture conversation:
 *
 *   1. read latency — cold + hot, against a real Edge Config
 *   2. write → read propagation time after `vercel edge-config update`
 *   3. behavior when the flag key is missing (returns {} not throw)
 *   4. whether the SDK does its own caching (does a second fetch round-trip?)
 *   5. integration via our `edgeConfigSource()` adapter
 *
 * Auth: reads EDGE_CONFIG from .env.local + uses `vercel edge-config update`
 * for writes (uses your `vercel login` session).
 *
 * Usage:
 *   ./scripts/setup-edge-config.sh   # one-time
 *   pnpm tsx examples/cli-smoke/edge-config-smoke.ts
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Flags } from "../../src/index.js";
import { edgeConfigSource } from "../../src/flag-sources/edge-config.js";

// ─── env loading ──────────────────────────────────────────────────────────
const envPath = resolve(process.cwd(), ".env.local");
try {
  const envText = readFileSync(envPath, "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
} catch {
  console.error(`couldn't read ${envPath} — run ./scripts/setup-edge-config.sh first`);
  process.exit(1);
}

const conn = process.env.EDGE_CONFIG;
if (!conn) {
  console.error("EDGE_CONFIG is empty — re-run setup script");
  process.exit(1);
}

const ecId = conn.match(/edge-config\.vercel\.com\/(ecfg_[^?]+)/)?.[1];
if (!ecId) {
  console.error("couldn't extract Edge Config id from EDGE_CONFIG");
  process.exit(1);
}

console.log(`[smoke] EDGE_CONFIG store: ${ecId}`);
console.log("");

// ─── helpers ──────────────────────────────────────────────────────────────
function timed<T>(label: string, fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  return (async () => {
    const t0 = performance.now();
    const value = await fn();
    return { ms: performance.now() - t0, value };
  })();
}

function writeFlags(value: object): void {
  const patch = JSON.stringify({
    items: [{ operation: "upsert", key: "flags", value }],
  });
  execFileSync("vercel", ["edge-config", "update", ecId!, "--patch", patch], {
    stdio: "pipe",
  });
}

// ─── 1. cold + hot read latency ───────────────────────────────────────────
console.log("[1] read latency (5 calls, fresh source each time)");
{
  for (let i = 0; i < 5; i++) {
    const src = edgeConfigSource();
    const r = await timed(`  call ${i + 1}`, () => src.read());
    console.log(`  call ${i + 1}: ${r.ms.toFixed(1)}ms — keys=${Object.keys(r.value).length}`);
  }
}
console.log("");

// ─── 2. SDK-internal caching check ────────────────────────────────────────
console.log("[2] SDK-internal cache (same source, 5 sequential reads)");
{
  const src = edgeConfigSource();
  for (let i = 0; i < 5; i++) {
    const r = await timed(`  call ${i + 1}`, () => src.read());
    console.log(`  call ${i + 1}: ${r.ms.toFixed(1)}ms`);
  }
}
console.log("");

// ─── 3. write → propagation ────────────────────────────────────────────────
console.log("[3] write → read propagation");
{
  const marker = `smoke-${Date.now()}`;
  console.log(`  writing { __smoke: "${marker}" } via vercel CLI...`);
  const wt = await timed("  write", async () => writeFlags({ __smoke: marker }));
  console.log(`  CLI write took ${wt.ms.toFixed(0)}ms`);

  const src = edgeConfigSource();
  const t0 = performance.now();
  let attempts = 0;
  let detected = -1;
  while (performance.now() - t0 < 30_000) {
    attempts++;
    const flags = (await src.read()) as Record<string, unknown>;
    if (flags.__smoke === marker) {
      detected = performance.now() - t0;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (detected < 0) {
    console.log(`  ✗ marker not visible after 30s (${attempts} attempts)`);
  } else {
    console.log(`  ✓ propagated in ${detected.toFixed(0)}ms (${attempts} polls)`);
  }
}
console.log("");

// ─── 4. missing-key behavior ──────────────────────────────────────────────
console.log("[4] missing-key behavior");
{
  const src = edgeConfigSource({ key: "definitely-not-a-real-key-zzz" });
  const r = await src.read();
  console.log(`  result: ${JSON.stringify(r)} (expected {})`);
}
console.log("");

// ─── 5. integration with Flags class ──────────────────────────────────────
console.log("[5] Flags class integration");
{
  writeFlags({
    "test-on": { on: true },
    "test-off": { on: false },
    "test-rollout-50": { on: true, rollout: 0.5 },
    "test-allowlist": { on: true, rollout: 0, users: ["u_beta"] },
  });
  // small wait — let CDN settle
  await new Promise((r) => setTimeout(r, 1500));

  const flags = new Flags({ source: edgeConfigSource() });
  await flags.ready();

  console.log(`  test-on(u1)         → ${flags.isOn("test-on", "u1")} (expected true)`);
  console.log(`  test-off(u1)        → ${flags.isOn("test-off", "u1")} (expected false)`);

  let on = 0;
  for (let i = 0; i < 1000; i++) if (flags.isOn("test-rollout-50", `u${i}`)) on++;
  console.log(`  test-rollout-50 (1000 users) → ${on} on (expected ~500, ±100)`);

  console.log(`  test-allowlist(u_beta)  → ${flags.isOn("test-allowlist", "u_beta")} (expected true)`);
  console.log(`  test-allowlist(u_other) → ${flags.isOn("test-allowlist", "u_other")} (expected false)`);
}
console.log("");

// ─── cleanup ──────────────────────────────────────────────────────────────
console.log("[cleanup] resetting flags key to {}");
writeFlags({});
console.log("done");
