// Returns a callable `() => void` that resolves the right store URL
// for the current EAS channel + platform and opens it via Linking.

import { useCallback } from "react";
import { Linking, Platform } from "react-native";
import * as Updates from "expo-updates";
import { openAppStore } from "../store-url.js";
import { useReleaseConfig } from "./use-release-config.js";

declare const __DEV__: boolean;

export interface UseOpenAppStoreOptions {
  iosAppId: string;
  androidPackage: string;
  /** Generic web fallback when both primary and store-default fail. */
  webFallback?: string;
}

export function useOpenAppStore(options: UseOpenAppStoreOptions): () => void {
  const config = useReleaseConfig();
  const { iosAppId, androidPackage, webFallback } = options;
  return useCallback(() => {
    // `Updates.channel` is empty for Metro dev clients (the JS isn't
    // served by EAS Update). In dev, treat that as the 'development'
    // channel so per-channel overrides work end-to-end.
    const isDev = typeof __DEV__ !== "undefined" && __DEV__;
    const channel =
      Updates.channel || (isDev ? "development" : "production");
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
  }, [config.updateUrls, iosAppId, androidPackage, webFallback]);
}
