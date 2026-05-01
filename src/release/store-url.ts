// Resolve and open the right "go install the latest" destination for a
// given EAS channel + platform. Falls back to public App Store /
// Play Store URLs built from the consumer's native IDs.

import type { UpdateUrls } from "./schema.js";

export interface OpenAppStoreOptions {
  /** App Store ID — required for iOS (the numeric id, not the bundle id). */
  iosAppId: string;
  /** Android package name — required for Android. */
  androidPackage: string;
  /**
   * EAS channel name (`production`, `preview`, `development`, …).
   * Defaults to `'production'`. The native `useOpenAppStore()` hook
   * passes `Updates.channel || (__DEV__ ? 'development' : 'production')`.
   */
  channel?: string;
  /** Per-channel URL overrides. Resolved from `releaseConfig.updateUrls`. */
  urls?: UpdateUrls;
  platform: "ios" | "android";
  /**
   * Function that opens a URL — defaults to React Native's `Linking.openURL`
   * when run in RN. Consumers in non-RN environments (Node, web) MUST pass
   * their own `openUrl`. The function may return a Promise; failures will
   * trigger the `fallback` URL.
   */
  openUrl: (url: string) => Promise<void> | void;
  /** Generic web fallback when both primary and store-default fail. */
  webFallback?: string;
}

function defaultStoreScheme(platform: "ios" | "android", iosAppId: string, androidPackage: string): string {
  return platform === "ios"
    ? `itms-apps://itunes.apple.com/app/id${iosAppId}`
    : `market://details?id=${androidPackage}`;
}

function defaultStoreWeb(platform: "ios" | "android", iosAppId: string, androidPackage: string): string {
  return platform === "ios"
    ? `https://apps.apple.com/app/id${iosAppId}`
    : `https://play.google.com/store/apps/details?id=${androidPackage}`;
}

/**
 * Resolve the destination URL for a (channel, platform) pair without
 * actually opening it. Useful for logging, deeplink previews, tests.
 */
export function resolveAppStoreUrl(options: Omit<OpenAppStoreOptions, "openUrl" | "webFallback">): string {
  const { iosAppId, androidPackage, channel = "production", platform, urls } = options;
  const explicit = urls?.[channel]?.[platform];
  return explicit ?? defaultStoreScheme(platform, iosAppId, androidPackage);
}

/**
 * Open the resolved store URL via the supplied `openUrl`. On failure,
 * tries the web equivalent (when no explicit override was provided)
 * before giving up.
 */
export async function openAppStore(options: OpenAppStoreOptions): Promise<void> {
  const { iosAppId, androidPackage, channel = "production", platform, urls, openUrl, webFallback } = options;
  const explicit = urls?.[channel]?.[platform];
  const primary = explicit ?? defaultStoreScheme(platform, iosAppId, androidPackage);
  const fallback = explicit
    ? webFallback ?? defaultStoreWeb(platform, iosAppId, androidPackage)
    : defaultStoreWeb(platform, iosAppId, androidPackage);

  try {
    await openUrl(primary);
  } catch {
    try {
      await openUrl(fallback);
    } catch {
      // give up silently — caller already saw the first error
    }
  }
}
