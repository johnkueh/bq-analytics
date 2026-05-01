// Opinionated release schema — single source of truth for force-update
// gating, post-update what's-new copy, and per-channel store deeplinks.
//
// Stored under the Edge Config key `release`. Apps that need additional
// server-driven configuration use a separate `Config<T>` instance with
// their own key.
//
// The validator is intentionally permissive: only the `gate` shape is
// strictly checked. Unknown / extra fields pass through so a server can
// roll out a richer schema without breaking older clients.

// ---------- Pre-update (gate / store routing) ----------

export interface ReleaseGate {
  /** CFBundleVersion / versionCode floor for iOS. `0` disables. */
  minIosBuild: number;
  /** CFBundleVersion / versionCode floor for Android. `0` disables. */
  minAndroidBuild: number;
  /**
   * `true` → render the full-screen blocking screen, no dismiss.
   * `false` → render a soft, dismissible nudge.
   */
  hardBlock: boolean;
  /** Optional override for the gate copy. Falls back to a generic line. */
  message?: string;
}

/** Per-channel update destination. Keys are EAS channel names. */
export interface ChannelUpdateUrls {
  ios?: string;
  android?: string;
}

/**
 * Per-channel store URLs keyed by EAS channel (`production`, `preview`,
 * `development`, …). Pre-launch users on the `preview` channel typically
 * install via TestFlight / EAS APK link, not the public stores. If the
 * channel is unset, `openAppStore()` falls back to defaults built from
 * the consumer's iosAppId / androidPackage.
 */
export type UpdateUrls = Record<string, ChannelUpdateUrls>;

// ---------- Post-update (what's new) ----------

export interface WhatsNewEntry {
  title: string;
  body: string;
  /**
   * Optional CTA. `url` accepts both `https://...` (Safari View
   * Controller in-app) and app-scheme deeplinks. `label` is the button
   * text — keep short ("Read more", "Try it").
   */
  cta?: { label: string; url: string };
}

export interface WhatsNew {
  /** Release identifier — also used as the cross-session dedup key. */
  version: string;
  entries: WhatsNewEntry[];
}

// ---------- Top-level (what the Edge Config key holds) ----------

export interface ReleaseConfig {
  gate: ReleaseGate;
  whatsNew: WhatsNew | null;
  updateUrls?: UpdateUrls;
}

/** No-op default — gate disabled, no notes published, no URL overrides. */
export const DEFAULT_RELEASE_CONFIG: ReleaseConfig = {
  gate: { minIosBuild: 0, minAndroidBuild: 0, hardBlock: false },
  whatsNew: null,
};

/** Edge Config key holding the release blob. Apps shouldn't change this. */
export const RELEASE_KEY = "release";

/**
 * Permissive validator — only enforces the `gate` shape. Unknown fields
 * pass through so the server can roll out richer schemas without
 * breaking older clients. `whatsNew` and `updateUrls` are checked
 * structurally only when present (no strict entry validation).
 */
export function isReleaseConfig(value: unknown): value is ReleaseConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const gate = v.gate as Record<string, unknown> | undefined;
  if (!gate || typeof gate !== "object") return false;
  if (typeof gate.minIosBuild !== "number") return false;
  if (typeof gate.minAndroidBuild !== "number") return false;
  if (typeof gate.hardBlock !== "boolean") return false;
  return true;
}
