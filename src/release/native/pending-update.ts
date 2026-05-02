// Separate sub-entry for `<PendingUpdatePrompt>` and friends.
//
// Lives on its own export path (`bq-analytics/release/native/pending-update`)
// rather than the main `bq-analytics/release/native` so that consumers
// who don't use OTA don't transitively pull in `expo-updates`. The
// dep is opt-in by import path, not assumed.

export { PendingUpdatePrompt } from "./pending-update-prompt.js";
export type {
  PendingUpdatePromptProps,
  PendingUpdateRenderContext,
} from "./pending-update-prompt.js";
