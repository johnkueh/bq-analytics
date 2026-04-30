"use client";

import { Analytics } from "bq-analytics";
import { browserTransport, attachBrowserAutoFlush } from "bq-analytics/browser";

let cached: Analytics | null = null;

export function browserAnalytics(): Analytics {
  if (cached) return cached;
  cached = new Analytics({
    transport: browserTransport({ url: "/api/track" }),
  });
  attachBrowserAutoFlush(() => cached!.flush());
  return cached;
}
