// Generic typed config primitive — parallel to Flags but for arbitrary
// JSON blobs. A consumer wraps an external source (Edge Config / HTTP)
// and pulls the typed value out, with a fail-open default.
//
// Used by bq-analytics/release for the ReleaseConfig schema, but
// nothing about Config<T> is release-specific: any opinionated
// server-driven config (announcements, kill-switches, A/B fixtures)
// can ride this primitive.

export type ConfigValidator<T> = (value: unknown) => value is T;

/** Pluggable source — Edge Config / HTTP / file etc. all implement this. */
export interface ConfigSource<T> {
  /** Returns the typed value, or null when the source has nothing to offer. */
  read(): Promise<T | null>;
}

export interface ConfigOptions<T> {
  /** External source — `read()` is called on init and on `refresh()`. */
  source: ConfigSource<T>;
  /** Returned by `current()` until the first successful read. */
  defaultValue: T;
  /** Auto-refresh from `source` at this interval (ms). Optional. */
  refreshIntervalMs?: number;
  /** Fired after every successful read. Use for telemetry / debugging. */
  onChange?: (value: T) => void;
}

export class Config<T> {
  private cache: T;
  private readonly source: ConfigSource<T>;
  private readonly onChange?: (value: T) => void;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private readyPromise?: Promise<void>;

  constructor(options: ConfigOptions<T>) {
    this.cache = options.defaultValue;
    this.source = options.source;
    this.onChange = options.onChange;
    this.readyPromise = this.refresh();

    if (options.refreshIntervalMs && options.refreshIntervalMs > 0) {
      this.refreshTimer = setInterval(() => {
        void this.refresh().catch((err) => {
          console.warn("[bq-analytics] config refresh failed:", err);
        });
      }, options.refreshIntervalMs);
      // Don't keep Node processes alive just for refresh.
      const t = this.refreshTimer as { unref?: () => void };
      t.unref?.();
    }
  }

  /** Awaits the initial read. */
  async ready(): Promise<void> {
    if (this.readyPromise) await this.readyPromise;
  }

  /** Re-fetches from `source` and replaces the cached value. */
  async refresh(): Promise<void> {
    const value = await this.source.read();
    if (value !== null && value !== undefined) {
      this.cache = value;
      this.onChange?.(value);
    }
  }

  /** Latest known value. Returns the default until the first read lands. */
  current(): T {
    return this.cache;
  }

  /** Cancel the background refresh timer. */
  destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }
}
