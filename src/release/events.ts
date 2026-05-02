// Telemetry event names for the release subsystem. Apps should never
// hand-type these strings — import from this module so cross-app
// dashboards stay stable. Do not rename without a coordinated migration.

export const RELEASE_EVENTS = {
  /** Hard-gate appeared (fired once per session via UpdateGate). */
  GATE_SHOWN: "update_gate.shown",
  /** User tapped the feedback affordance on the hard-gate screen. */
  GATE_FEEDBACK_TAPPED: "update_gate.feedback_tapped",

  /** Release-notes sheet appeared (auto-open or manual). */
  NOTES_SHOWN: "whats_new.shown",
  /** User dismissed the release-notes sheet. */
  NOTES_DISMISSED: "whats_new.dismissed",
  /** User tapped the soft-gate "Update in App Store" CTA. */
  NOTES_UPDATE_TAPPED: "whats_new.update_tapped",
  /** User tapped the feedback affordance from the release-notes sheet. */
  NOTES_FEEDBACK_TAPPED: "whats_new.feedback_tapped",
  /** User tapped a per-entry CTA inside the release-notes sheet. */
  NOTES_CTA_TAPPED: "whats_new.cta_tapped",

  /** Pending-update sheet appeared (a downloaded OTA is ready to apply
   *  and the user hasn't dismissed this bundle's per-bundle key yet). */
  PENDING_UPDATE_SHOWN: "pending_update.shown",
  /** User tapped the apply CTA — Updates.reloadAsync() is being called. */
  PENDING_UPDATE_APPLIED: "pending_update.applied",
  /** User dismissed the pending-update sheet without applying. */
  PENDING_UPDATE_DISMISSED: "pending_update.dismissed",
} as const;

export type ReleaseEventName = (typeof RELEASE_EVENTS)[keyof typeof RELEASE_EVENTS];
