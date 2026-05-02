// AsyncStorage keys used by the release subsystem on React Native.
//
// **Do not change these strings.** Existing recipes.im installs (and any
// other deployed consumer) already key their dedup state off these
// exact names. Renaming would orphan everyone's `lastSeen` and treat
// existing users as fresh installs on next launch.

/** First-launch probe — set to `'1'` after the first cold-start that
 *  observed a published `whatsNew`. Used to suppress release notes for
 *  brand-new users who never had the previous version. */
export const HAS_LAUNCHED_KEY = "app:has_launched";

/** Last `whatsNew.version` the user dismissed. Cross-session dedup for
 *  the `'ok'` verdict; ignored for `'soft'` so the nudge keeps showing. */
export const LAST_SEEN_KEY = "whatsNew:last_seen";

/** Local cache of the last successful `releaseConfig` fetch. Read on
 *  cold-start to render the gate / sheet immediately, then refreshed
 *  in the background. */
export const RELEASE_CACHE_KEY = "release-config:cached";

/** Per-bundle dismissal key prefix for `<PendingUpdatePrompt>`. The
 *  full key is `pendingUpdate:dismissed:<updateId>`. Storing per-bundle
 *  means dismissing one downloaded OTA doesn't suppress the next one
 *  (each bundle gets its own dismissal decision). */
export const PENDING_UPDATE_DISMISSED_KEY_PREFIX =
  "pendingUpdate:dismissed:";
