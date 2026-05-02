// Returns a callable `() => void` that resolves the right store URL
// for the supplied channel + platform and opens it via Linking.
//
// `channel` was previously read from `Updates.channel` (expo-updates)
// inside this hook, but pulling that import in transitively bloated
// `bq-analytics/release/native` for consumers who don't use OTA. The
// consumer now passes channel in (typically `Updates.channel ||
// (__DEV__ ? 'development' : 'production')` — a one-liner upstream).
// Default 'production' so projects that never set a non-production
// channel keep working with no changes.

import { useCallback } from "react";
import { Linking, Platform } from "react-native";
import { openAppStore } from "../store-url.js";
import { useReleaseConfig } from "./use-release-config.js";

export interface UseOpenAppStoreOptions {
  iosAppId: string;
  androidPackage: string;
  /** EAS channel name (`production`, `preview`, `development`, …). The
   *  consumer typically reads this from `Updates.channel` in expo-updates
   *  and passes it in. Defaults to `'production'` if omitted. */
  channel?: string;
  /** Generic web fallback when both primary and store-default fail. */
  webFallback?: string;
}

export function useOpenAppStore(options: UseOpenAppStoreOptions): () => void {
  const config = useReleaseConfig();
  const { iosAppId, androidPackage, channel = "production", webFallback } =
    options;
  return useCallback(() => {
    const platform: "ios" | "android" = Platform.OS === "ios" ? "ios" : "android";
    void openAppStore({
      iosAppId,
      androidPackage,
      channel,
      platform,
      urls: config.updateUrls,
      openUrl: (url) => Linking.openURL(url),
      webFallback,
    });
  }, [config.updateUrls, iosAppId, androidPackage, channel, webFallback]);
}
