// Pure gate evaluator. Stateless; safe to call anywhere. The native
// hooks compose this with `Constants.nativeBuildVersion` and
// `Platform.OS`; tests / non-RN consumers feed the inputs directly.

import type { ReleaseGate } from "./schema.js";

export type GateVerdict = "ok" | "soft" | "hard";

export interface EvaluateGateOptions {
  gate: ReleaseGate;
  /** CFBundleVersion / versionCode of the running native binary, or null. */
  currentBuild: number | null;
  platform: "ios" | "android";
  /**
   * When `currentBuild` is null and we're in dev mode, substitute this
   * value so the gate can be smoke-tested over Metro (where the manifest
   * doesn't include `nativeBuildVersion`). Pass `0` (or omit) to
   * fail-open in dev too. The native hooks default this to `1` when
   * `__DEV__` is true.
   */
  fallbackInDev?: number;
  /** Caller's `__DEV__` flag. Defaults to `false` (production semantics). */
  isDev?: boolean;
}

/**
 * Returns `'ok'` when the user is at or above the platform floor, the
 * gate is disabled (min === 0), or `currentBuild` is missing in prod
 * (fail-open — never brick an install over a misconfigured manifest).
 * `'soft'` and `'hard'` are mutually-exclusive only when the user is
 * actually behind; the schema's `hardBlock` flag picks between them.
 */
export function evaluateGate(options: EvaluateGateOptions): GateVerdict {
  const { gate, platform, currentBuild, fallbackInDev, isDev = false } = options;

  const min = platform === "ios" ? gate.minIosBuild : gate.minAndroidBuild;
  if (!min) return "ok";

  let resolved: number;
  if (currentBuild != null && Number.isFinite(currentBuild)) {
    resolved = currentBuild;
  } else if (isDev && fallbackInDev != null && fallbackInDev > 0) {
    resolved = fallbackInDev;
  } else {
    return "ok"; // fail-open
  }

  if (resolved >= min) return "ok";
  return gate.hardBlock ? "hard" : "soft";
}
