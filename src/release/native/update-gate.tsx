// Headless gate component — replaces children with the consumer's
// hard-block UI when the verdict resolves to `'hard'`. Soft and ok
// verdicts pass children through; the soft prompt is surfaced by
// `<ReleaseNotesPrompt>`, which adapts its CTA based on verdict.
//
// The consumer provides their own UI via `renderHardBlock`. The
// component supplies `message` (from `releaseConfig.gate.message`)
// and an `openStore` callback that's already wired with the right
// channel + platform + urls.

import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Analytics } from "../../core.js";
import { RELEASE_EVENTS } from "../events.js";
import { useGateVerdict } from "./use-gate-verdict.js";
import { useOpenAppStore } from "./use-open-app-store.js";
import {
  configureReleaseConfig,
  useReleaseConfig,
} from "./use-release-config.js";

export interface UpdateGateRenderHardBlockContext {
  message?: string;
  openStore: () => void;
}

export interface UpdateGateProps {
  children: ReactNode;
  /**
   * Required: render the consumer's hard-block UI. Receives a `message`
   * (server-supplied or undefined — consumer falls back to its own
   * default copy) and an `openStore()` callback.
   */
  renderHardBlock: (ctx: UpdateGateRenderHardBlockContext) => ReactNode;
  /** App Store id (numeric, not bundle id). Required for iOS routing. */
  iosAppId: string;
  /** Android package name. Required for Android routing. */
  androidPackage: string;
  /** EAS channel name forwarded to `useOpenAppStore` for resolving
   *  per-channel store URL overrides. Typically
   *  `Updates.channel || (__DEV__ ? 'development' : 'production')` —
   *  the consumer reads it because we want to keep this entry free of
   *  `expo-updates` imports. Defaults to `'production'` if omitted. */
  channel?: string;
  /**
   * URL to fetch the release config JSON. Required unless the
   * consumer has already called `configureReleaseConfig()` at the
   * module scope. Typically the public `/api/release-config`
   * endpoint backed by `createReleaseConfigRoute()`.
   */
  apiUrl?: string;
  /** Network timeout (ms) for the config fetch. Default 2000. */
  timeoutMs?: number;
  /**
   * Optional Analytics instance. When supplied, fires
   * `update_gate.shown verdict='hard'` once per session.
   */
  analytics?: Analytics;
}

export function UpdateGate({
  children,
  renderHardBlock,
  iosAppId,
  androidPackage,
  channel,
  apiUrl,
  timeoutMs,
  analytics,
}: UpdateGateProps): ReactElement {
  // Lazy-configure the store on first mount. `configureReleaseConfig`
  // is idempotent (first call wins), so multiple gates / repeat
  // mounts won't compete.
  if (apiUrl) {
    configureReleaseConfig({
      url: apiUrl,
      asyncStorage: AsyncStorage,
      timeoutMs,
    });
  }

  const config = useReleaseConfig();
  const verdict = useGateVerdict();
  const openStore = useOpenAppStore({ iosAppId, androidPackage, channel });
  const reportedRef = useRef(false);

  useEffect(() => {
    if (verdict !== "hard" || reportedRef.current) return;
    reportedRef.current = true;
    analytics?.track(RELEASE_EVENTS.GATE_SHOWN, {
      verdict: "hard",
      min_build:
        Platform.OS === "ios"
          ? config.gate.minIosBuild
          : config.gate.minAndroidBuild,
      current_build: Constants.nativeBuildVersion ?? null,
    });
  }, [verdict, config.gate, analytics]);

  if (verdict === "hard") {
    return (
      <>{renderHardBlock({ message: config.gate.message, openStore })}</>
    );
  }
  return <>{children}</>;
}
