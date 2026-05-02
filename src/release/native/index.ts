// bq-analytics/release/native — React Native components and hooks for
// the release subsystem. Headless: consumers provide UI via render
// props.
//
// Peer deps required: react ^18, react-native, expo-constants,
// expo-updates, expo-web-browser, @react-native-async-storage/async-storage.

export {
  configureReleaseConfig,
  useReleaseConfig,
} from "./use-release-config.js";
export type { StoreConfig } from "./store.js";

export { useGateVerdict } from "./use-gate-verdict.js";
export { useOpenAppStore } from "./use-open-app-store.js";
export type { UseOpenAppStoreOptions } from "./use-open-app-store.js";

export { UpdateGate } from "./update-gate.js";
export type {
  UpdateGateProps,
  UpdateGateRenderHardBlockContext,
} from "./update-gate.js";

export { ReleaseNotesPrompt } from "./release-notes-prompt.js";
export type {
  ReleaseNotesPromptProps,
  ReleaseNotesRenderContext,
  ReleaseNotesVerdict,
} from "./release-notes-prompt.js";

// PendingUpdatePrompt is intentionally NOT re-exported from this entry —
// it depends on `expo-updates`, and importing it transitively would
// force every consumer of `bq-analytics/release/native` to install
// expo-updates even if they don't use OTA. Import it explicitly from
// `bq-analytics/release/native/pending-update` instead.

export { useReleaseNotes } from "./use-release-notes.js";
export type {
  UseReleaseNotesOptions,
  UseReleaseNotesResult,
} from "./use-release-notes.js";
