// Minimal feature-flag evaluator. Pure JS — safe for browser / RN / server.
//
// Two flag sources:
//   • Inline: flags committed in code (`new Flags({ flags: {...} })`).
//   • External: any object that returns a FlagMap from `read()` —
//     edgeConfigSource() ships in this package; httpSource() / file etc.
//     are trivial to write.
//
// Exposures auto-emit as `$flag_called` events through the supplied
// Analytics instance, deduped to first exposure per (flag, userId, on)
// in this process. SQL-side, prefer aggregating on MIN(ts) per
// (user_id, key) — survives process restarts.

import type { Analytics } from "./core.js";

export type Flag = {
  /** Master switch. When false, isOn() always returns false. */
  on: boolean;
  /** Fraction of users to bucket on (0..1). Default 1 = everyone. */
  rollout?: number;
  /** Allowlist — users in this list bypass the rollout and get on=true. */
  users?: string[];
};

export type FlagMap = Record<string, Flag>;

/** A pluggable flag source. Edge Config / HTTP / file etc. all implement this. */
export interface FlagSource {
  read(): Promise<FlagMap>;
}

export interface FlagsConfig<F extends FlagMap> {
  /** Inline flags — used directly without any I/O. */
  flags?: F;
  /** External source — read() is called on init and on refresh(). */
  source?: FlagSource;
  /** Auto-refresh from `source` at this interval (ms). No-op without a source. */
  refreshIntervalMs?: number;
  /** Optional Analytics instance — when set, exposures auto-track. */
  analytics?: Analytics;
  /** Override the exposure event name. Default "$flag_called". */
  exposureEvent?: string;
}

export class Flags<F extends FlagMap = FlagMap> {
  private cache: FlagMap;
  private analytics?: Analytics;
  private exposureEvent: string;
  private seen = new Set<string>();
  private source?: FlagSource;
  private readyPromise?: Promise<void>;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(config: FlagsConfig<F>) {
    this.cache = config.flags ?? {};
    this.analytics = config.analytics;
    this.exposureEvent = config.exposureEvent ?? "$flag_called";
    this.source = config.source;

    if (this.source) {
      this.readyPromise = this.refresh();
    }
    if (config.refreshIntervalMs && this.source) {
      this.refreshTimer = setInterval(() => {
        void this.refresh().catch((err) => {
          console.warn("[bq-analytics] flag refresh failed:", err);
        });
      }, config.refreshIntervalMs);
      // Don't keep Node processes alive just for refresh
      const t = this.refreshTimer as { unref?: () => void };
      t.unref?.();
    }
  }

  /** Awaits the initial load when a source is configured. No-op for inline. */
  async ready(): Promise<void> {
    if (this.readyPromise) await this.readyPromise;
  }

  /** Re-fetches from `source` and replaces the in-memory cache. */
  async refresh(): Promise<void> {
    if (!this.source) return;
    this.cache = await this.source.read();
  }

  /** Stops the auto-refresh timer. Call on graceful shutdown. */
  close(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  isOn(key: keyof F & string, userId: string): boolean {
    const f = this.cache[key];
    if (!f?.on) return this.emit(key, userId, false);
    if (f.users?.includes(userId)) return this.emit(key, userId, true);
    const rollout = f.rollout ?? 1;
    if (rollout >= 1) return this.emit(key, userId, true);
    if (rollout <= 0) return this.emit(key, userId, false);
    const bucket = hash32(`${userId}:${key}`) / 0xffffffff;
    return this.emit(key, userId, bucket < rollout);
  }

  private emit(key: string, userId: string, on: boolean): boolean {
    if (this.analytics) {
      const dedupKey = `${key}:${userId}:${on}`;
      if (!this.seen.has(dedupKey)) {
        this.seen.add(dedupKey);
        this.analytics.track(this.exposureEvent, { key, on }, { userId });
      }
    }
    return on;
  }
}

// FNV-1a 32-bit. Deterministic across runtimes, no crypto dependency.
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
