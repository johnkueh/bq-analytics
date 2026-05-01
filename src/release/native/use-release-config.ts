// React hook returning the current ReleaseConfig. Vanilla
// `useSyncExternalStore` over the module-level store — no React Query
// dependency.

import { useSyncExternalStore } from "react";
import {
  configureStore,
  getSnapshot,
  subscribe,
  type StoreConfig,
} from "./store.js";
import type { ReleaseConfig } from "../schema.js";

/**
 * One-time configuration hook. Call from a component that mounts at the
 * app root (UpdateGate does this internally). Subsequent calls are no-ops.
 */
export function configureReleaseConfig(config: StoreConfig): void {
  configureStore(config);
}

/**
 * Returns the latest ReleaseConfig. Falls back to
 * `DEFAULT_RELEASE_CONFIG` until the first successful fetch (or the
 * AsyncStorage cache hydrates, whichever is first).
 */
export function useReleaseConfig(): ReleaseConfig {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
