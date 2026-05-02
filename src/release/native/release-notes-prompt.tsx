// Headless release-notes prompt. Auto-opens the consumer-supplied
// sheet UI on cold-start whenever there's a published `whatsNew` and
// the gate verdict is not `'hard'` (hard renders the gate's own
// blocking screen, no sheet on top).
//
// Verdict-aware dedup:
//   - 'ok' (user has the latest binary) → cross-session via lastSeen
//     (show once per version, then leave them alone).
//   - 'soft' (user below soft gate) → session-only (re-fires every
//     cold-start so the nudge keeps reminding until they update).
//
// Bundle-version gating (optional `appVersion` prop): when supplied,
// suppresses the sheet until `appVersion === notes.version`. Solves
// the OTA race where Edge Config flips notes ahead of expo-updates
// applying the matching bundle — without this, users read about
// features they don't yet have. Only applies in 'ok' verdict; 'soft'
// always shows so the nudge can describe what they're missing.
//
// Fresh-install probe: distinguishes a *true* fresh install (suppress;
// new users shouldn't see release notes for features they've never not
// had) from an *upgrade from pre-feature code* (existing user, other
// AsyncStorage keys present → show once on this cold-start, then dedup
// normally going forward).
//
// Manual re-access (e.g. a "What's new" row in a settings menu) is
// handled by `useReleaseNotes()`, which flips the shared visibility
// singleton — no prop drilling required.

import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { Linking } from "react-native";
import * as WebBrowser from "expo-web-browser";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Analytics } from "../../core.js";
import {
  HAS_LAUNCHED_KEY,
  LAST_SEEN_KEY,
} from "../async-storage-keys.js";
import { RELEASE_EVENTS } from "../events.js";
import type { GateVerdict } from "../evaluate-gate.js";
import type { WhatsNew } from "../schema.js";
import { useGateVerdict } from "./use-gate-verdict.js";
import { useOpenAppStore } from "./use-open-app-store.js";
import { useReleaseConfig } from "./use-release-config.js";
import {
  setVisibleSingleton,
  useVisible,
} from "./visibility-store.js";

declare const __DEV__: boolean;

export type ReleaseNotesVerdict = Extract<GateVerdict, "ok" | "soft">;

export interface ReleaseNotesRenderContext {
  notes: WhatsNew;
  verdict: ReleaseNotesVerdict;
  /** Open URL — themed Safari View Controller for https / Linking otherwise. */
  onCtaTap: (url: string) => void;
  /** Verdict='soft' only: opens the App Store / TestFlight. Tracks update_tapped. */
  onUpdate: () => void;
  /** Closes the sheet, persists lastSeen for 'ok', fires whats_new.dismissed. */
  onDismiss: () => void;
  /** Wire into the sheet's `isOpen` / `visible` prop. */
  visible: boolean;
}

export interface ReleaseNotesPromptProps {
  iosAppId: string;
  androidPackage: string;
  /**
   * Render the consumer's sheet UI. Receives the active context plus
   * `visible` — wire `visible` into the sheet's visibility prop. The
   * consumer owns presentation (TrueSheet, Modal, custom).
   */
  render: (ctx: ReleaseNotesRenderContext) => ReactNode;
  /**
   * Optional Analytics. When supplied, fires `whats_new.*` events
   * (auto/manual shown, dismissed, update_tapped, cta_tapped).
   */
  analytics?: Analytics;
  /** Theme hint for the in-app Safari View Controller. */
  isDark?: boolean;
  /**
   * The version of the app the user is *currently running* — typically
   * `Constants.expoConfig?.version` from `expo-constants`. When supplied,
   * the sheet is suppressed until this matches `notes.version`.
   *
   * Why: Edge Config can flip the published `whatsNew.version` ahead of
   * the matching OTA bundle being applied (expo-updates' default flow
   * caches the new bundle and applies it on next cold-start). Without
   * this gate the user reads "What's new in 1.0.2" while still on the
   * 1.0.1 bundle — the listed features may not exist yet.
   *
   * Only applies in `'ok'` verdict. `'soft'` always shows because the
   * point of soft-gate notes is to describe what they're missing.
   *
   * Omit (or pass undefined) to keep the legacy behavior — sheet shows
   * as soon as `notes.version !== LAST_SEEN_KEY`.
   */
  appVersion?: string;
}

export function ReleaseNotesPrompt({
  iosAppId,
  androidPackage,
  render,
  analytics,
  isDark,
  appVersion,
}: ReleaseNotesPromptProps): ReactElement | null {
  const config = useReleaseConfig();
  const target = config.whatsNew;
  const verdict = useGateVerdict();
  const openStore = useOpenAppStore({ iosAppId, androidPackage });
  const visible = useVisible();
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!target || verdict === "hard") return;
    if (sessionRef.current === target.version) return;
    sessionRef.current = target.version;

    let cancelled = false;
    void (async () => {
      const [launched, seen] = await Promise.all([
        AsyncStorage.getItem(HAS_LAUNCHED_KEY),
        AsyncStorage.getItem(LAST_SEEN_KEY),
      ]);
      if (cancelled) return;

      if (!__DEV__ && !launched) {
        // Distinguish true fresh install from upgrade-from-pre-feature.
        const allKeys = await AsyncStorage.getAllKeys();
        const hasOtherAppState = allKeys.some(
          (k) => k !== HAS_LAUNCHED_KEY && k !== LAST_SEEN_KEY,
        );
        if (!hasOtherAppState) {
          // Two `setItem` calls (rather than `multiSet`) so this
          // works across AsyncStorage v1/v2/v3, which renamed the
          // bulk API.
          await AsyncStorage.setItem(HAS_LAUNCHED_KEY, "1");
          await AsyncStorage.setItem(LAST_SEEN_KEY, target.version);
          return;
        }
        // Upgrade — mark launched but leave lastSeen null so the sheet
        // shows on this cold-start.
        await AsyncStorage.setItem(HAS_LAUNCHED_KEY, "1");
      }

      // 'ok' verdict gets cross-session dedup. 'soft' re-fires every
      // cold-start. __DEV__ skips dedup either way for smoke-testing.
      if (!__DEV__ && verdict === "ok" && target.version === seen) return;

      // Bundle-version gate (opt-in via appVersion prop). Only enforced
      // in 'ok' verdict — 'soft' is meant to describe upcoming features
      // for users who haven't updated yet, so we don't gate it. Skipped
      // in __DEV__ to keep smoke testing simple.
      if (
        !__DEV__ &&
        verdict === "ok" &&
        appVersion &&
        appVersion !== target.version
      ) {
        return;
      }

      setVisibleSingleton(true);
      analytics?.track(RELEASE_EVENTS.NOTES_SHOWN, {
        version: target.version,
        from_version: seen ?? null,
        verdict,
        source: "auto",
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [target, verdict, analytics, appVersion]);

  if (!target || verdict === "hard") return null;

  function handleDismiss(): void {
    if (!target) return;
    void AsyncStorage.setItem(LAST_SEEN_KEY, target.version).catch(() => {});
    setVisibleSingleton(false);
    analytics?.track(RELEASE_EVENTS.NOTES_DISMISSED, {
      version: target.version,
      verdict,
    });
  }

  function handleUpdate(): void {
    if (!target) return;
    analytics?.track(RELEASE_EVENTS.NOTES_UPDATE_TAPPED, {
      version: target.version,
    });
    openStore();
    setVisibleSingleton(false);
  }

  function handleCtaTap(url: string): void {
    if (!target) return;
    analytics?.track(RELEASE_EVENTS.NOTES_CTA_TAPPED, {
      version: target.version,
      cta_url: url,
    });
    if (/^https?:\/\//i.test(url)) {
      void WebBrowser.openBrowserAsync(url, {
        toolbarColor: isDark ? "#0a0a0a" : "#ffffff",
        dismissButtonStyle: "done",
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
      return;
    }
    Linking.openURL(url).catch(() => {});
  }

  const sheetVerdict = verdict as ReleaseNotesVerdict;
  return (
    <>
      {render({
        notes: target,
        verdict: sheetVerdict,
        visible,
        onDismiss: handleDismiss,
        onUpdate: handleUpdate,
        onCtaTap: handleCtaTap,
      })}
    </>
  );
}
