#!/usr/bin/env tsx
/**
 * Targeting + lifecycle smoke against a real Edge Config:
 *
 *   1. allowlist (rollout: 0 + users: [...])
 *   2. rollout % bucketing (deterministic, even split)
 *   3. allowlist + rollout combined
 *   4. cohort materialization: simulate BQ → user_id[] → Edge Config write
 *      → Flags.refresh() picks up new allowlist
 *   5. exposure events ($flag_called) actually emitted with correct shape
 *   6. refreshIntervalMs auto-pulls a mid-life update
 *   7. cleanup
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Analytics, Flags } from "../../src/index.js";
import { edgeConfigSource } from "../../src/flag-sources/edge-config.js";
import type { BufferedRecord, Transport } from "../../src/types.js";

// ─── env ─────────────────────────────────────────────────────────────────
const envPath = resolve(process.cwd(), ".env.local");
const envText = readFileSync(envPath, "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
}
const conn = process.env.EDGE_CONFIG!;
const ecId = conn.match(/edge-config\.vercel\.com\/(ecfg_[^?]+)/)![1]!;
console.log(`[smoke] EDGE_CONFIG store: ${ecId}\n`);

// ─── helpers ─────────────────────────────────────────────────────────────
function writeFlags(value: object): void {
  execFileSync(
    "vercel",
    [
      "edge-config",
      "update",
      ecId,
      "--patch",
      JSON.stringify({
        items: [{ operation: "upsert", key: "flags", value }],
      }),
    ],
    { stdio: "pipe" },
  );
}

function makeMockAnalytics() {
  const sent: BufferedRecord[] = [];
  const transport: Transport = {
    async send(records) {
      sent.push(...records);
    },
  };
  const analytics = new Analytics({ transport, flushAt: 1 });
  return { analytics, sent };
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─── 1. allowlist with rollout: 0 (only listed users on) ─────────────────
console.log("[1] allowlist with rollout: 0");
{
  writeFlags({
    "beta-feature": { on: true, rollout: 0, users: ["u_alice", "u_bob"] },
  });
  await new Promise((r) => setTimeout(r, 1500));
  const f = new Flags({ source: edgeConfigSource() });
  await f.ready();
  check("u_alice (in list) → on", f.isOn("beta-feature", "u_alice") === true);
  check("u_bob (in list) → on", f.isOn("beta-feature", "u_bob") === true);
  check("u_carol (not in list) → off", f.isOn("beta-feature", "u_carol") === false);
  check("u_dave (not in list) → off", f.isOn("beta-feature", "u_dave") === false);
}

// ─── 2. rollout %: deterministic, ~even ───────────────────────────────────
console.log("\n[2] rollout 0.3 over 2000 users");
{
  writeFlags({ "ramp-feature": { on: true, rollout: 0.3 } });
  await new Promise((r) => setTimeout(r, 1500));
  const f = new Flags({ source: edgeConfigSource() });
  await f.ready();
  let on = 0;
  for (let i = 0; i < 2000; i++) if (f.isOn("ramp-feature", `u${i}`)) on++;
  const pct = on / 2000;
  check(
    `~30% bucket (got ${(pct * 100).toFixed(1)}%, expected 25-35%)`,
    pct >= 0.25 && pct <= 0.35,
  );

  // determinism: same user → same answer
  const a = new Flags({ source: edgeConfigSource() });
  await a.ready();
  const b = new Flags({ source: edgeConfigSource() });
  await b.ready();
  let determinismMatches = 0;
  for (let i = 0; i < 100; i++) {
    if (a.isOn("ramp-feature", `u${i}`) === b.isOn("ramp-feature", `u${i}`)) determinismMatches++;
  }
  check(`deterministic across instances (100/100)`, determinismMatches === 100);
}

// ─── 3. allowlist + rollout combined ──────────────────────────────────────
console.log("\n[3] allowlist + rollout (force-on testers)");
{
  writeFlags({
    combo: { on: true, rollout: 0.1, users: ["u_force_on"] },
  });
  await new Promise((r) => setTimeout(r, 1500));
  const f = new Flags({ source: edgeConfigSource() });
  await f.ready();
  check("forced user always on", f.isOn("combo", "u_force_on") === true);

  // make sure rollout still applies to non-listed users (bounded check)
  let on = 0;
  for (let i = 0; i < 1000; i++) if (f.isOn("combo", `u${i}`)) on++;
  check(
    `rollout still ~10% for non-listed (got ${(on / 1000) * 100}%)`,
    on >= 60 && on <= 140,
  );
}

// ─── 4. cohort materialization flow ──────────────────────────────────────
console.log("\n[4] cohort materialization flow");
{
  writeFlags({ "cohort-flag": { on: true, rollout: 0, users: [] } });
  await new Promise((r) => setTimeout(r, 1500));

  // mid-life refresh
  const f = new Flags({ source: edgeConfigSource() });
  await f.ready();
  check("before cohort: u_pro1 → off", f.isOn("cohort-flag", "u_pro1") === false);

  // simulate "BQ returned these user_ids" → write to allowlist
  const cohortUsers = ["u_pro1", "u_pro2", "u_pro3"];
  writeFlags({
    "cohort-flag": { on: true, rollout: 0, users: cohortUsers },
  });
  await new Promise((r) => setTimeout(r, 1500));
  await f.refresh();

  check("after cohort write + refresh: u_pro1 → on", f.isOn("cohort-flag", "u_pro1") === true);
  check("after cohort write + refresh: u_pro2 → on", f.isOn("cohort-flag", "u_pro2") === true);
  check(
    "after cohort write + refresh: u_outside → off",
    f.isOn("cohort-flag", "u_outside") === false,
  );
}

// ─── 5. exposure tracking ─────────────────────────────────────────────────
console.log("\n[5] exposure tracking ($flag_called → analytics)");
{
  writeFlags({
    exp: { on: true, rollout: 0.5 },
    exp2: { on: false },
  });
  await new Promise((r) => setTimeout(r, 1500));

  const { analytics, sent } = makeMockAnalytics();
  const f = new Flags({ source: edgeConfigSource(), analytics });
  await f.ready();

  f.isOn("exp", "u1");
  f.isOn("exp", "u2");
  f.isOn("exp", "u1"); // dup — should not emit again
  f.isOn("exp2", "u1");

  // wait for batched flushes
  await new Promise((r) => setTimeout(r, 100));
  await analytics.flush();

  const events = sent
    .filter((r) => r.kind === "event")
    .map((r) => {
      if (r.kind !== "event") throw new Error("unreachable");
      return { ...r.row, properties: JSON.parse(r.row.properties) };
    });
  check(`emitted 3 unique exposures (got ${events.length})`, events.length === 3);
  check(
    "all events named $flag_called",
    events.every((e) => e.event_name === "$flag_called"),
  );
  check(
    "exp2 exposure carries on=false",
    events.some((e) => e.properties.key === "exp2" && e.properties.on === false),
  );
  check(
    "exp exposure for u1 carries deterministic on value",
    events.filter((e) => e.properties.key === "exp" && e.user_id === "u1").length === 1,
  );
}

// ─── 6. refreshIntervalMs auto-refresh ────────────────────────────────────
console.log("\n[6] refreshIntervalMs auto-refresh (2s interval)");
{
  writeFlags({ "auto-refresh": { on: false } });
  await new Promise((r) => setTimeout(r, 1500));

  const f = new Flags({ source: edgeConfigSource(), refreshIntervalMs: 2000 });
  await f.ready();
  check("initial state: off", f.isOn("auto-refresh", "u1") === false);

  writeFlags({ "auto-refresh": { on: true } });
  // wait for both Edge Config propagation and the next refresh tick
  await new Promise((r) => setTimeout(r, 3500));
  check("after auto-refresh: on", f.isOn("auto-refresh", "u1") === true);
  f.close();
}

// ─── cleanup ──────────────────────────────────────────────────────────────
console.log("\n[cleanup] reset flags key to {}");
writeFlags({});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
