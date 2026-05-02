---
name: bq-analytics-release
description: Add release-time UX (force-update gate, post-update what's-new sheet, channel-aware store deeplinks) to a project that has bq-analytics, then operate it — draft release notes, flip the gate, push hard-blocks during incidents. Backed by Vercel Edge Config under the key `release`. Use when the user wants force-update / what's-new sheets, says "add release notes", or asks how to gate / nudge users to update.
---

# bq-analytics release management

Server-driven release UX in one Edge Config blob. Powers four user-facing surfaces:

| State | What user sees | Trigger |
|---|---|---|
| Hard block | Full-screen, no dismiss, "Update now" | `verdict === 'hard'` |
| Soft nudge | Sheet with "Update in App Store" + "Later" | `verdict === 'soft'` |
| Just updated | Sheet with "Got it" + entries | `whatsNew.version > lastSeen`, verdict `ok` |
| OTA available | Existing prompt + `whatsNew` titles as bullets | `Updates.useUpdates()` |

The blob lives at Edge Config key `release`:

```json
{
  "gate": {
    "minIosBuild": 0,
    "minAndroidBuild": 0,
    "hardBlock": false,
    "message": "optional override copy"
  },
  "whatsNew": null,
  "updateUrls": {
    "production": { "ios": "itms-apps://...", "android": "market://..." },
    "preview":    { "ios": "itms-beta://..." }
  }
}
```

Mutate via the `bq-release` CLI shipped in the package. Sub-second propagation through Vercel Edge Config (60s CDN cache on the consumer-facing route).

## Detect current state

| Signal | What it means | Where to start |
|---|---|---|
| `bq-analytics` in deps, `EDGE_CONFIG=` in env, `release` key seeded | fully wired | jump to **Operate** |
| `bq-analytics` + Edge Config store from flags, no `release` key | flags wired, release not yet | **Step 2** (skip provisioning) |
| `bq-analytics` in deps, no `EDGE_CONFIG=` | greenfield for Edge Config | **Step 1** |
| no `bq-analytics` | run `/bq-analytics-install` first |  |

```bash
grep -E '"bq-analytics"' package.json && echo "sdk present"
grep -E '^EDGE_CONFIG=' .env.local 2>/dev/null && echo "edge config provisioned"
pnpm exec bq-release show 2>/dev/null && echo "release key live" || echo "release key missing"
```

## Step 1 — Provision Edge Config

If the project already ran `/bq-analytics-flags`, the store exists — skip ahead. Otherwise:

```bash
./node_modules/bq-analytics/scripts/setup-edge-config.sh
```

Idempotent. Creates a `bq-analytics-flags` Edge Config store, mints a read token, pushes `EDGE_CONFIG` to Vercel Production env. Same store hosts both `flags` and `release` keys — keeping them together avoids a second read URL.

## Step 2 — Seed the `release` key

```bash
./node_modules/bq-analytics/scripts/setup-release.sh
```

Idempotent. Initializes the `release` key with the no-op default (gate disabled, no whatsNew, no URL overrides). After this, `bq-release` is callable via `pnpm exec bq-release`.

## Step 3 — Wire the server route

### Next.js App Router

```ts
// src/app/api/release-config/route.ts
import { createReleaseConfigRoute } from "bq-analytics/next/release";
export const GET = createReleaseConfigRoute();
```

### Hono

```ts
// src/lib/api/main-app.ts
import { createReleaseConfigRoute } from "bq-analytics/next/release";
const releaseRoute = createReleaseConfigRoute();
app.get("/api/release-config", (c) => releaseRoute(c.req.raw));
```

The handler reads from Edge Config, validates with `isReleaseConfig` (permissive — only `gate` shape is enforced), and returns the JSON with a 60s edge cache. Failures fall back to `DEFAULT_RELEASE_CONFIG` so clients always get a structurally-valid response.

## Step 4 — Wire the client (Expo / React Native)

Headless components mount at the app root. Consumer provides UI via render props.

```tsx
// app/src/app/_layout.tsx (or your root component)
import * as Updates from "expo-updates";
import Constants from "expo-constants";
import { UpdateGate, ReleaseNotesPrompt } from "bq-analytics/release/native";
// Optional: only if you want the auto-summoned "Update ready" sheet for OTAs.
// Lives on its own sub-entry so the main `release/native` stays expo-updates-free.
import { PendingUpdatePrompt } from "bq-analytics/release/native/pending-update";
import { ForceUpdateScreen } from "@/components/ForceUpdateScreen";
import { WhatsNewSheet } from "@/components/WhatsNewSheet";
import { PendingUpdateSheet } from "@/components/PendingUpdateSheet";

const IOS_APP_ID = "<your App Store Connect ID>";
const ANDROID_PACKAGE = "<your.package.name>";

// Read these once, forward to every component that needs them.
const channel = Updates.channel || (__DEV__ ? "development" : "production");
const releaseTag =
  (Constants.expoConfig?.extra?.releaseTag as string | undefined) ??
  Constants.expoConfig?.version;

<UpdateGate
  iosAppId={IOS_APP_ID}
  androidPackage={ANDROID_PACKAGE}
  channel={channel}
  renderHardBlock={({ message, openStore }) => (
    <ForceUpdateScreen message={message} onUpdate={openStore} />
  )}
>
  <App />
  <ReleaseNotesPrompt
    iosAppId={IOS_APP_ID}
    androidPackage={ANDROID_PACKAGE}
    channel={channel}
    appVersion={releaseTag}
    render={(ctx) => <WhatsNewSheet {...ctx} />}
  />
  <PendingUpdatePrompt
    render={(ctx) => <PendingUpdateSheet {...ctx} />}
  />
</UpdateGate>
```

`WhatsNewSheet` `ctx` = `{notes, verdict, visible, onDismiss, onUpdate, onCtaTap}`. Verdict drives the primary CTA: `'ok'` → "Got it", `'soft'` → "Update in App Store" + "Later".

`PendingUpdateSheet` `ctx` = `{updateId, visible, onApply, onDismiss, applying}`. Auto-fires when `Updates.useUpdates().isUpdatePending` && `availableUpdate.updateId !== currentlyRunning.updateId` && the bundle hasn't been dismissed via the per-bundle key (`pendingUpdate:dismissed:<updateId>` in AsyncStorage). Tap-to-apply gates on a deliberate user action — no auto-reload, no AppState foreground polling (both are anti-patterns at the consumer level; the prompt enforces them at the package level).

### Why two props (`appVersion` and `channel`)?

- `appVersion` is the WhatsNewSheet gate key. When set, the sheet stays suppressed until the user is on a bundle whose label matches `notes.version` — solves the OTA race where Edge Config flips notes ahead of expo-updates applying the matching bundle. Pass `Constants.expoConfig?.extra?.releaseTag` (or `Constants.expoConfig?.version` if you don't separate release labeling from the App Store version).
- `channel` is the per-channel store-deeplink key (e.g. preview goes to TestFlight, production to App Store). Pass `Updates.channel || (__DEV__ ? 'development' : 'production')`. The package deliberately doesn't read `Updates.channel` itself — keeps the main `release/native` entry expo-updates-free for consumers who don't ship OTA.

### Why is `PendingUpdatePrompt` on a separate sub-entry?

It depends on `expo-updates` (for `useUpdates()` + `reloadAsync()`). Importing it from the main `release/native` would force every consumer of that entry to install expo-updates even if they only use the gate / notes UI. The sub-entry pattern means OTA dependence is opt-in by import path, not assumed.

### Manual re-access

Add a "What's new" entry to a settings or household menu so users can revisit notes:

```tsx
import { useReleaseNotes } from "bq-analytics/release/native";

function SettingsMenu() {
  const release = useReleaseNotes();
  if (!release.available) return null;
  return (
    <Row label={`What's new (${release.version})`} onPress={release.open} />
  );
}
```

## Telemetry

Event names exported as constants — never hand-type them; cross-app dashboards rely on stability.

```ts
import { RELEASE_EVENTS } from "bq-analytics/release";
// "update_gate.shown"      | "update_gate.feedback_tapped"
// "whats_new.shown"        | "whats_new.dismissed" | "whats_new.update_tapped"
// "pending_update.shown"   | "pending_update.applied" | "pending_update.dismissed"
//                            (carry update_id in properties for per-bundle apply rate)
// "whats_new.feedback_tapped" | "whats_new.cta_tapped"
```

Properties on `whats_new.shown`: `{ version, from_version, verdict, source }` where `source` is `'auto'` (cold-start) or `'manual'` (menu re-access). Cohorts slice naturally by the existing `app_version` / `build_number` / `runtime_version` traits on `identify`.

## Operating release config — `bq-release` CLI

```bash
pnpm exec bq-release show                         # human-readable current state
pnpm exec bq-release show --json                  # raw JSON
pnpm exec bq-release gate off
pnpm exec bq-release gate soft <minBuild>         # nudge users below minBuild
pnpm exec bq-release gate hard <minBuild> --message "Critical fix for X"
pnpm exec bq-release notes <version> --from notes.json
echo '<entries-json>' | pnpm exec bq-release notes <version>
pnpm exec bq-release clear-notes
pnpm exec bq-release urls set <channel> <platform> <url>
pnpm exec bq-release urls remove <channel> [<platform>]
```

All write commands accept `--dry-run` — print the merged JSON without pushing. **Always `--dry-run` first for hard blocks.**

The CLI does read-merge-write, so partial updates don't blow away other fields. Reads directly from Edge Config when `EDGE_CONFIG` is in env (no CDN cache lag). Override the slug per-project:

```bash
pnpm exec bq-release --slug your-edge-config-slug show
# or set BQ_RELEASE_SLUG=your-slug in env
```

## Drafting release notes — voice and shape

Each entry is one user-visible improvement. Keep entries to 3–5 max per release.

```ts
{
  title: string,        // ≤ 40 chars, scannable, title case
  body: string,         // 1-2 sentences, sentence case, what changed in user terms
  cta?: {
    label: string,      // ≤ 18 chars, action-oriented ("Try it", "Read more")
    url: string         // https:// (Safari View) or app://... (deeplink)
  }
}
```

**Voice is project-specific** — the consuming app should layer a per-project skill on top of this one with their tone / style guide. Generic principles:

- Lead with the user-visible change, not the engineering work
- Concrete benefit, not feature-name-in-a-vacuum
- Skip internal refactors, build tweaks, anything a user would shrug at
- Skip dates / version numbers in titles — the sheet's title bar shows the version

## End-to-end workflow — drafting a release

When the user asks "draft release notes for v1.1.0":

1. **Survey changes** — `git log <prev-tag>..HEAD --oneline`. Identify user-facing items.
2. **Draft 3-5 entries** matching voice/shape rules.
3. **Show preview** in chat — full `WhatsNew` JSON.
4. **Iterate** with the user.
5. **Dry-run** to confirm the merged config:
   ```bash
   echo '<entries-json>' | pnpm exec bq-release notes v1.1.0 --dry-run
   ```
6. **Apply** — re-run without `--dry-run`.
7. **Verify** with `pnpm exec bq-release show`.

## End-to-end workflow — incident hard block

When the user says "hard block, build 42 minimum, recipe import is broken":

1. Draft a tight incident message: ≤ 100 chars, says what's broken and what to do.
2. **Always `--dry-run` first** — hard blocks lock out every install at next AppState→active:
   ```bash
   pnpm exec bq-release gate hard 42 \
     --message "Recipe import is broken on this version. Update to keep importing." \
     --dry-run
   ```
3. Confirm with the user.
4. Apply.
5. Watch BQ for `update_gate.shown verdict=hard` events ramping up.

To reset:

```bash
pnpm exec bq-release gate off
```

## Coordinating with EAS / native rebuilds

There's no automation hooking these together. Recommended order for a release that includes native changes:

1. `pnpm build:prod` (or equivalent EAS build for production native binary)
2. Wait for TestFlight / App Store availability
3. `pnpm exec bq-release gate soft <newBuild>` so users below get nudged
4. `pnpm exec bq-release notes <version> --from notes.json`
5. `pnpm update:all` if there's an OTA on top
6. Watch `whats_new.shown` events to confirm rollout

For OTA-only releases (no new native binary):

1. Draft notes describing the JS-only changes.
2. `pnpm exec bq-release notes <version> --from notes.json`
3. `pnpm update:all`
4. Existing OTA prompt automatically picks up `whatsNew.entries` titles as bullets.

## Things to never do

- **Never push a hard block without `--dry-run` first.** Every install at next AppState→active is locked out.
- **Never edit `vercel edge-config update` patches by hand** — bypassing the CLI loses read-merge-write semantics, so other fields get wiped.
- **Never repeat a `whatsNew.version` value** — cross-session dedup keys off this string. Same value = sheet won't auto-show.
- **Never include a CTA URL that 404s** (e.g. a help article that hasn't shipped yet).
- **Never rename the Edge Config key, AsyncStorage keys, or telemetry event names.** Existing installs have state keyed off the exact strings; a rename orphans them.

## Telemetry to watch after a release

```sql
SELECT ts, event_name, properties
FROM `<project>.events.raw`
WHERE ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
  AND event_name LIKE 'whats_new%'
ORDER BY ts DESC
LIMIT 20
```

Healthy signals: `whats_new.shown` events with the new `version`, mix of `verdict: 'ok'` / `'soft'` depending on gate aggressiveness, `whats_new.dismissed` close behind.

If `whats_new.shown verdict='soft'` but few `whats_new.update_tapped`, the soft nudge isn't converting — consider a stricter gate or clearer copy.

## Schema reference

```ts
type ReleaseConfig = {
  gate: {
    minIosBuild: number;       // 0 disables
    minAndroidBuild: number;
    hardBlock: boolean;        // true = full-screen
    message?: string;          // optional override
  };
  whatsNew: null | {
    version: string;           // dedup key, also displayed
    entries: Array<{
      title: string;
      body: string;
      cta?: { label: string; url: string };
    }>;
  };
  updateUrls?: Record<string, { ios?: string; android?: string }>;
  // Keys: EAS channel names ('production', 'preview', 'development', …)
};
```

The validator is permissive — only `gate` shape is enforced. Extra fields pass through, so a server can roll out richer schemas without breaking older clients.
