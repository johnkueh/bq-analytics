// Composes useReleaseConfig + evaluateGate + native build version.

import { Platform } from "react-native";
import Constants from "expo-constants";
import { evaluateGate, type GateVerdict } from "../evaluate-gate.js";
import { useReleaseConfig } from "./use-release-config.js";

declare const __DEV__: boolean;

export function useGateVerdict(): GateVerdict {
  const config = useReleaseConfig();
  const platform: "ios" | "android" = Platform.OS === "ios" ? "ios" : "android";
  const raw = Constants.nativeBuildVersion;
  const currentBuild = raw ? Number(raw) : null;

  return evaluateGate({
    gate: config.gate,
    platform,
    currentBuild,
    isDev: typeof __DEV__ !== "undefined" && __DEV__,
    fallbackInDev: 1,
  });
}
