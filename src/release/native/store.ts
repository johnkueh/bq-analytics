// Module-level singleton store for the active ReleaseConfig.
//
// Replaces what would otherwise be a React Query (or Zustand, or
// MobX) integration with ~50 lines of vanilla code. Wired up via
// `useSyncExternalStore` in `use-release-config.ts`.
//
// Lifecycle:
//   - First subscriber kicks off (a) hydration from AsyncStorage cache
//     and (b) a network refetch in parallel.
//   - AppState→active triggers a refetch.
//   - All subscribers re-render when `cached` changes.
//
// Multiple components calling `useReleaseConfig()` share the same
// fetch — no thundering herd.

import { AppState } from "react-native";
import {
  RELEASE_CACHE_KEY,
} from "../async-storage-keys.js";
import {
  DEFAULT_RELEASE_CONFIG,
  type ReleaseConfig,
  isReleaseConfig,
} from "../schema.js";

export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface StoreConfig {
  url: string;
  /** Abort the fetch after this many ms. Default 2000. */
  timeoutMs?: number;
  /** AsyncStorage-shaped object — pass `@react-native-async-storage/async-storage`. */
  asyncStorage: AsyncStorageLike;
  /** Override `fetch` (tests). */
  fetcher?: typeof fetch;
}

let storeConfig: StoreConfig | null = null;
let cached: ReleaseConfig = DEFAULT_RELEASE_CONFIG;
let inflight: Promise<void> | null = null;
let hydrated = false;
let appStateWired = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function configureStore(config: StoreConfig): void {
  // First call wins — subsequent calls noop. Apps mount the gate once
  // at the root; reconfiguring mid-session would invalidate cached
  // state and surprise existing subscribers.
  if (!storeConfig) {
    storeConfig = config;
    if (!appStateWired) {
      AppState.addEventListener("change", (state) => {
        if (state === "active") void refetch();
      });
      appStateWired = true;
    }
  }
}

async function hydrate(): Promise<void> {
  if (hydrated || !storeConfig) return;
  hydrated = true;
  try {
    const raw = await storeConfig.asyncStorage.getItem(RELEASE_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (cached === DEFAULT_RELEASE_CONFIG && isReleaseConfig(parsed)) {
      cached = parsed;
      emit();
    }
  } catch {
    // ignore — corrupt cache just means we wait for the network fetch
  }
}

export async function refetch(): Promise<void> {
  if (inflight) return inflight;
  if (!storeConfig) return;
  const config = storeConfig;
  inflight = (async () => {
    const f = config.fetcher ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 2000);
    try {
      const res = await f(config.url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) return;
      const body = (await res.json()) as unknown;
      if (!isReleaseConfig(body)) return;
      cached = body;
      emit();
      void config.asyncStorage
        .setItem(RELEASE_CACHE_KEY, JSON.stringify(body))
        .catch(() => {});
    } catch {
      // network / parse failure — keep last good `cached`
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void hydrate().finally(() => {
      void refetch();
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): ReleaseConfig {
  return cached;
}

/** Test-only helper. Resets module state so each test starts clean. */
export function __resetStore(): void {
  storeConfig = null;
  cached = DEFAULT_RELEASE_CONFIG;
  inflight = null;
  hydrated = false;
  appStateWired = false;
  listeners.clear();
}
