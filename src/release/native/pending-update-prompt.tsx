// Headless pending-update prompt. Auto-summons the consumer-supplied
// sheet/banner UI whenever expo-updates has a downloaded-but-not-yet-
// applied bundle that's different from the currently running one and
// the user hasn't dismissed this bundle's per-bundle key.
//
// Decoupled from `<ReleaseNotesPrompt>`:
//   - ReleaseNotesPrompt is version-keyed (release-config notes) and
//     dedups once-per-version-dismissed via LAST_SEEN_KEY.
//   - PendingUpdatePrompt is bundle-keyed (per OTA updateId) and dedups
//     per-bundle via `pendingUpdate:dismissed:<updateId>`.
//
// Idiomatic-Expo pattern (mirrors expo/UpdatesAPIDemo's UpdateMonitor):
//   - useUpdates() drives state passively. The prompt does NOT call
//     checkForUpdateAsync or fetchUpdateAsync itself — bundle discovery
//     is delegated to expo-updates' `checkAutomatically` configuration
//     (typically `'ON_LOAD'`).
//   - We deliberately do NOT chain checkForUpdateAsync to AppState
//     foreground transitions. That combination caused a cascade in an
//     early consumer where a user N OTAs behind would chain-reload
//     through every queued bundle in seconds (recipes.im post-mortem
//     2026-05-02 — see commit dc7410f). Cold-start-only bundle
//     discovery is the safe default; if a consumer truly needs warm-
//     foreground checks they can add it themselves with full ownership
//     of the implications.
//   - Updates.reloadAsync() is called from the consumer's deliberate
//     onApply tap. NEVER from inside an AppState listener (that pattern
//     can crash on Android — expo/expo#16264).
//
// __DEV__ skip by default — there's no real OTA in dev. Consumer can
// override via `enabledInDev` to preview the visual.

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Updates from "expo-updates";
import type { Analytics } from "../../core.js";
import { PENDING_UPDATE_DISMISSED_KEY_PREFIX } from "../async-storage-keys.js";
import { RELEASE_EVENTS } from "../events.js";

declare const __DEV__: boolean;

export interface PendingUpdateRenderContext {
  /** The updateId of the pending bundle. Useful for analytics keys. */
  updateId: string;
  /** Wire into the consumer's sheet/banner visibility prop. */
  visible: boolean;
  /** Calls Updates.reloadAsync(). Persists the per-bundle dismissal key
   *  first so the prompt doesn't re-show on the next bundle's first
   *  paint (race-safe across the JS-context teardown). */
  onApply: () => void;
  /** Persists the per-bundle dismissal key and hides the prompt. The
   *  next genuinely-different updateId will surface again. */
  onDismiss: () => void;
  /** True while reloadAsync is in flight — disable apply button to
   *  avoid double-taps. */
  applying: boolean;
}

export interface PendingUpdatePromptProps {
  /**
   * Render the consumer's sheet/banner UI. Receives the active context
   * including `visible` — wire `visible` into the visibility prop. The
   * consumer owns presentation (TrueSheet, Modal, banner, custom).
   */
  render: (ctx: PendingUpdateRenderContext) => ReactNode;
  /**
   * Optional Analytics. When supplied, fires `pending_update.*` events
   * (shown, applied, dismissed) keyed by updateId.
   */
  analytics?: Analytics;
  /**
   * Render the prompt in `__DEV__` too. Default false (skipped in dev
   * because expo-updates doesn't surface real OTAs there). Useful for
   * previewing the visual via a forced render in your sheet wrapper.
   */
  enabledInDev?: boolean;
}

export function PendingUpdatePrompt({
  render,
  analytics,
  enabledInDev = false,
}: PendingUpdatePromptProps): ReactElement | null {
  const { isUpdatePending, availableUpdate, currentlyRunning } =
    Updates.useUpdates();

  const [dismissedUpdateId, setDismissedUpdateId] = useState<string | null>(
    null,
  );
  const [hydratedForId, setHydratedForId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const updateId = availableUpdate?.updateId ?? null;

  // Hydrate the dismissed key when an availableUpdate appears. Per-
  // bundle key so dismissing one bundle doesn't bleed across the next.
  // Track which updateId we hydrated for so the consumer can suppress
  // a one-frame flash before AsyncStorage resolves.
  useEffect(() => {
    if (!updateId) {
      setDismissedUpdateId(null);
      setHydratedForId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const v = await AsyncStorage.getItem(
          PENDING_UPDATE_DISMISSED_KEY_PREFIX + updateId,
        );
        if (cancelled) return;
        setDismissedUpdateId(v ? updateId : null);
        setHydratedForId(updateId);
      } catch {
        if (cancelled) return;
        setDismissedUpdateId(null);
        setHydratedForId(updateId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [updateId]);

  // The expo-updates state machine sometimes lists the running update
  // as also the available one (without bricking-measures the startup
  // re-fetches the latest even when it matches what's running). Suppress
  // the prompt in that case — there's nothing to apply.
  const isDifferent =
    !!updateId && updateId !== currentlyRunning.updateId;

  const dismissedForThisBundle =
    !!dismissedUpdateId && dismissedUpdateId === updateId;

  // Wait for AsyncStorage hydration for THIS updateId before opening,
  // otherwise a previously-dismissed bundle flashes the prompt for a
  // frame before the dismissal state lands.
  const hydratedForThisBundle =
    !!updateId && hydratedForId === updateId;

  const visible =
    (enabledInDev || !__DEV__) &&
    isUpdatePending &&
    isDifferent &&
    hydratedForThisBundle &&
    !dismissedForThisBundle;

  // Track that the prompt became visible (once per bundle). Fires
  // before the consumer's sheet animation, so analytics arrives fresh
  // even if the user dismisses immediately.
  useEffect(() => {
    if (visible && updateId) {
      analytics?.track(RELEASE_EVENTS.PENDING_UPDATE_SHOWN, {
        update_id: updateId,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, updateId]);

  const persistDismissal = useCallback(
    async (id: string): Promise<void> => {
      try {
        await AsyncStorage.setItem(
          PENDING_UPDATE_DISMISSED_KEY_PREFIX + id,
          "1",
        );
      } catch {
        // Non-fatal — the prompt just re-shows on next render. The
        // consumer can choose to surface this via their own catch.
      }
      setDismissedUpdateId(id);
    },
    [],
  );

  const handleApply = useCallback((): void => {
    if (!updateId || applying) return;
    setApplying(true);
    void (async () => {
      analytics?.track(RELEASE_EVENTS.PENDING_UPDATE_APPLIED, {
        update_id: updateId,
      });
      // Persist dismissal BEFORE reload — Updates.reloadAsync tears
      // down the JS context, so any post-call writes may not commit.
      // Without this the prompt could re-show on the next bundle's
      // first paint if the user quickly dismisses the post-reload
      // sheet without backgrounding.
      await persistDismissal(updateId);
      try {
        await Updates.reloadAsync();
      } catch {
        // No pending update / race — release the apply state so the
        // user can retry or dismiss.
        setApplying(false);
      }
    })();
  }, [analytics, applying, persistDismissal, updateId]);

  const handleDismiss = useCallback((): void => {
    if (!updateId) return;
    analytics?.track(RELEASE_EVENTS.PENDING_UPDATE_DISMISSED, {
      update_id: updateId,
    });
    void persistDismissal(updateId);
  }, [analytics, persistDismissal, updateId]);

  return (
    <>
      {render({
        updateId: updateId ?? "",
        visible,
        onApply: handleApply,
        onDismiss: handleDismiss,
        applying,
      })}
    </>
  );
}
