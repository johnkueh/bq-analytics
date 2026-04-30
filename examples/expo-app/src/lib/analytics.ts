// Drop into an Expo app. Requires:
//   pnpm add bq-analytics @react-native-async-storage/async-storage
//
// `react-native` and friends are not part of this monorepo's deps, so this
// file is reference shape — it won't typecheck inside bq-analytics itself.
// Copy into a real Expo app to use.

// @ts-nocheck — types live in the consuming Expo app, not here.
import { Analytics, Flags, httpSource } from "bq-analytics";
import {
  reactNativeTransport,
  attachExpoErrorHandler,
  attachAppStateFlush,
} from "bq-analytics/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Platform } from "react-native";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "https://your-app.vercel.app";

let cachedUserId: string | undefined;
export function setUserId(id: string | undefined) {
  cachedUserId = id;
}

export const analytics = new Analytics({
  transport: reactNativeTransport({
    url: `${API_URL}/api/track`,
    storage: AsyncStorage,
  }),
});

attachExpoErrorHandler(analytics, ErrorUtils, () => ({
  platform: Platform.OS,
  userId: cachedUserId,
}));
attachAppStateFlush(analytics, AppState, () => ({ userId: cachedUserId }));

export const flags = new Flags({
  source: httpSource({ url: `${API_URL}/api/flags` }),
});
