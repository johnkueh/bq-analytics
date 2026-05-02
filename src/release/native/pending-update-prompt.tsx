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
//   - useUpdates() drives state passively. By default the prompt does
//     NOT call checkForUpdateAsync or fetchUpdateAsync itself — bundle
//     discovery is delegated to expo-updates' `checkAutomatically`
//     configuration (typically `'ON_LOAD'`).
//   - Opt-in `silentReloadAfterBackgroundMs` enables warm-foreground
//     bundle discovery + silent reload, gated by a long-background
//     threshold. See the prop docs for the cascade-safety design.
//   - reloadAsync IS called from inside an AppState listener when the
//     opt-in feature is enabled — but only on the post-fetch-result
//     path, not synchronously inside the listener. AppState +
//     reloadAsync directly was the expo/expo#16264 crash pattern;
//     we await fetchUpdateAsync first which puts a microtask boundary
//     between the listener and the reload, sidestepping the issue.
//   - Updates.reloadAsync() from the consumer's deliberate onApply tap
//     remains the primary apply path; the silent path is additive.
//
// __DEV__ skip by default — there's no real OTA in dev. Consumer can
// override via `enabledInDev` to preview the visual.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { AppState, type AppStateStatus } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Updates from "expo-updates";
import type { Analytics } from "../../core.js";
import { PENDING_UPDATE_DISMISSED_KEY_PREFIX } from "../async-storage-keys.js";
import { RELEASE_EVENTS } from "../events.js";

declare const __DEV__: boolean;

// AsyncStorage keys for the silent-reload feature. Persistent across
// JS-context teardown (which reloadAsync triggers) so the cascade guard
// survives the very reload it just performed.
const BACKGROUND_AT_KEY = "pendingUpdate:lastBackgroundedAt";
const LAST_RELOAD_AT_KEY = "pendingUpdate:lastReloadedAt";

// Cascade guard: minimum ms since the previous reload before the silent
// path will fire again. The dc7410f recipes.im post-mortem chain-
// reloaded through queued bundles in seconds; 60s is well above any
// reload-induced AppState round-trip while still letting the next
// genuine long-background-return trigger silent updates.
const RELOAD_COOLDOWN_MS = 60_000;

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
   * Optional. Render a full-screen blocking overlay during the silent
   * reload path (only fires when `silentReloadAfterBackgroundMs` is
   * also set). The overlay paints for ~200ms before reloadAsync tears
   * down the JS context, so the user sees overlay → native splash →
   * new bundle as one continuous screen instead of a sheet flash.
   *
   * If omitted, the silent reload still fires but the user briefly
   * sees whatever screen they were on (or a moment of the regular
   * PendingUpdate sheet) before the reload kicks in.
   *
   * Recommended: render the same splash/launch image the OS shows on
   * cold-start so the visual handoff is invisible. While the overlay
   * is showing, the regular `render` prop's `visible` is forced false
   * to avoid a sheet flash competing with the overlay.
   */
  renderApplying?: () => ReactNode;
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
  /**
   * When set, enables silent OTA application on background→active
   * transitions where the previous background lasted at least this many
   * ms. The behavior on a qualifying transition:
   *   1. checkForUpdateAsync — discover any new bundle published while
   *      the app was backgrounded.
   *   2. fetchUpdateAsync — download it.
   *   3. reloadAsync — apply silently, no sheet, no user tap.
   *
   * The user perceives a brief loading state on returning to the app
   * (visually identical to a cold-start) and lands on the new bundle.
   * Active foreground sessions are never interrupted; short app-switches
   * (back-to-back tabs to a chat for 30s) don't trigger because the
   * background duration is too short.
   *
   * Cascade guard: the silent path is suppressed for 60s after any
   * reload (reload → 'active' transition with backgroundedFor < 1s
   * would otherwise loop through queued bundles). Combined with the
   * background-duration threshold this is double-safe.
   *
   * Recommended values:
   *   - 120_000 (2 min) for short-session apps (consumer)
   *   - 600_000 (10 min) for long-session apps (productivity)
   *
   * Omit (or set to undefined) to keep the conservative default —
   * bundle discovery only on cold-start, sheet-driven apply only.
   *
   * Per the Expo docs recommendation: "only do a reload in the
   * background if the app has been inactive for a certain period of
   * time, after which a user is unlikely to expect the app to restore
   * its previous state."
   */
  silentReloadAfterBackgroundMs?: number;
}

export function PendingUpdatePrompt({
  render,
  renderApplying,
  analytics,
  enabledInDev = false,
  silentReloadAfterBackgroundMs,
}: PendingUpdatePromptProps): ReactElement | null {
  const { isUpdatePending, availableUpdate, currentlyRunning } =
    Updates.useUpdates();
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  // True while the silent path is fetching+applying. When true, the
  // consumer's renderApplying overlay paints over everything and the
  // regular render prop's `visible` is forced false. Cleared on error
  // (so the user can see the regular sheet path); on success, the JS
  // context tears down before this state matters.
  const [silentApplying, setSilentApplying] = useState(false);

  // Silent reload on long-background-return. Skipped in __DEV__ (no
  // real OTA there) and when the prop is omitted (current behavior).
  useEffect(() => {
    if (silentReloadAfterBackgroundMs == null) return;
    if (__DEV__ && !enabledInDev) return;

    const sub = AppState.addEventListener("change", (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;

      if (next !== "active") {
        if (prev === "active") {
          void AsyncStorage.setItem(BACKGROUND_AT_KEY, String(Date.now())).catch(
            () => {},
          );
        }
        return;
      }
      if (prev === "active") return;

      // Active transition. Read both timestamps; if they're missing
      // we treat them as "ancient" so the first ever return triggers.
      void (async () => {
        try {
          const [bgAt, reloadedAt] = await Promise.all([
            AsyncStorage.getItem(BACKGROUND_AT_KEY),
            AsyncStorage.getItem(LAST_RELOAD_AT_KEY),
          ]);
          const now = Date.now();
          const bgDuration = bgAt ? now - parseInt(bgAt, 10) : Infinity;
          const sinceReload = reloadedAt
            ? now - parseInt(reloadedAt, 10)
            : Infinity;

          // Cascade guard: if we just reloaded, the immediate active
          // transition is the reload's own state churn, not a real
          // user return. Don't act on it.
          if (sinceReload < RELOAD_COOLDOWN_MS) return;
          if (bgDuration < silentReloadAfterBackgroundMs) return;

          const result = await Updates.checkForUpdateAsync();
          if (!result.isAvailable) return;
          // Set silentApplying=true BEFORE the fetch so the regular
          // PendingUpdate sheet stays suppressed for the entire
          // fetch+reload window. Setting it AFTER the fetch (the
          // 0.7.2 ordering) let the sheet briefly render during the
          // fetch when isUpdatePending was already true from a prior
          // checkForUpdateAsync — user sees a sheet flash, then a
          // broken modal-stack on reload (recipes.im incident
          // 2026-05-02 ~01:48). This sequencing fix is the actual
          // fix; the renderApplying overlay is the visible-to-user
          // half but the suppression timing was the latent bug.
          setSilentApplying(true);
          // Give the consumer's renderApplying overlay one render
          // frame to paint before we kick off the fetch. Without
          // this the user sees their existing screen during the
          // ~1-3s fetch.
          await new Promise((resolve) => setTimeout(resolve, 16));
          await Updates.fetchUpdateAsync();
          // Persist BEFORE reload — reloadAsync tears down the JS
          // context, so any post-call write may not commit. Without
          // this the cooldown guard wouldn't fire on the reload's
          // own active transition.
          await AsyncStorage.setItem(LAST_RELOAD_AT_KEY, String(now)).catch(
            () => {},
          );
          analytics?.track(RELEASE_EVENTS.PENDING_UPDATE_APPLIED, {
            update_id: result.manifest?.id ?? "",
            silent: true,
            bg_duration_ms: bgDuration,
          });
          await Updates.reloadAsync();
        } catch {
          // Network / not-signed-in / no-update / etc — silent. The
          // existing sheet path still surfaces any pending bundle on
          // the next user interaction.
          setSilentApplying(false);
        }
      })();
    });
    return () => sub.remove();
  }, [analytics, enabledInDev, silentReloadAfterBackgroundMs]);

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
    !silentApplying &&
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
        silent: false,
      });
      // Persist dismissal BEFORE reload — Updates.reloadAsync tears
      // down the JS context, so any post-call writes may not commit.
      // Without this the prompt could re-show on the next bundle's
      // first paint if the user quickly dismisses the post-reload
      // sheet without backgrounding.
      await persistDismissal(updateId);
      // Seed the silent-reload cascade guard. If both paths exist
      // (user tap + silent on long-background) and the user manually
      // applies, the next 'active' transition shouldn't redundantly
      // trigger the silent path.
      await AsyncStorage.setItem(LAST_RELOAD_AT_KEY, String(Date.now())).catch(
        () => {},
      );
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
      {silentApplying && renderApplying ? renderApplying() : null}
    </>
  );
}
