import { Flags, type FlagMap, type FlagSource } from "bq-analytics";
import { edgeConfigSource } from "bq-analytics/edge-config";
import { analytics } from "./analytics";

/**
 * Static fallback flag map used when EDGE_CONFIG isn't set (e.g. running
 * the example with `pnpm dev` against a fresh checkout). Real apps point
 * at a real Edge Config provisioned by `scripts/setup-edge-config.sh`.
 */
const FALLBACK_FLAGS: FlagMap = {
  "feedback-widget": { on: true, rollout: 1 },
  "new-checkout": { on: true, rollout: 0.5 },
  "ai-suggestions": { on: true, users: ["demo-user"] },
  "kill-old-flow": { on: false },
};

const inlineSource: FlagSource = {
  async read() {
    return FALLBACK_FLAGS;
  },
};

export const flagSource: FlagSource = process.env.EDGE_CONFIG
  ? edgeConfigSource()
  : inlineSource;

declare global {
  // eslint-disable-next-line no-var
  var __bqaFlags: Flags | undefined;
}

export function flags(): Flags {
  if (!globalThis.__bqaFlags) {
    globalThis.__bqaFlags = new Flags({
      source: flagSource,
      analytics: analytics(),
      refreshIntervalMs: 60_000,
    });
  }
  return globalThis.__bqaFlags;
}
