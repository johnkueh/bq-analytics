// Manual re-access entry — surface "What's new (X)" rows in settings /
// household menus. Returns whether release notes are currently
// published and an `open()` to show them via `<ReleaseNotesPrompt>`.
//
// Internally talks to the visibility singleton in `visibility-store`,
// so consumers can call `open()` from anywhere in the tree without
// prop-drilling state.

import { useCallback } from "react";
import type { Analytics } from "../../core.js";
import { RELEASE_EVENTS } from "../events.js";
import { useGateVerdict } from "./use-gate-verdict.js";
import { useReleaseConfig } from "./use-release-config.js";
import { setVisibleSingleton } from "./visibility-store.js";

export interface UseReleaseNotesOptions {
  /** Optional Analytics — fires `whats_new.shown source='manual'`. */
  analytics?: Analytics;
}

export interface UseReleaseNotesResult {
  /** True when there's published `whatsNew` and verdict isn't hard. */
  available: boolean;
  /** Latest version string for menu labels (e.g. `"What's new (1.1.0)"`). */
  version: string | null;
  /** Imperatively present the sheet. No-op when `available` is false. */
  open: () => void;
}

export function useReleaseNotes(
  options: UseReleaseNotesOptions = {},
): UseReleaseNotesResult {
  const config = useReleaseConfig();
  const verdict = useGateVerdict();
  const { analytics } = options;
  const target = config.whatsNew;
  const available = !!target && verdict !== "hard";

  const open = useCallback(() => {
    if (!target || verdict === "hard") return;
    setVisibleSingleton(true);
    analytics?.track(RELEASE_EVENTS.NOTES_SHOWN, {
      version: target.version,
      verdict,
      source: "manual",
    });
  }, [target, verdict, analytics]);

  return {
    available,
    version: target?.version ?? null,
    open,
  };
}
