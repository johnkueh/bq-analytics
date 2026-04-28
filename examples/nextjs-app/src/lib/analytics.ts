import { Analytics, bqTransport } from "bq-analytics";

declare global {
  // eslint-disable-next-line no-var
  var __bqa: Analytics | undefined;
}

/** Module-singleton — survives across Fluid Compute invocations. */
export function analytics(): Analytics {
  if (!globalThis.__bqa) {
    globalThis.__bqa = new Analytics({
      transport: bqTransport({
        projectId: process.env.GCP_PROJECT_ID!,
        eventsDataset: process.env.BQ_EVENTS_DATASET ?? "events",
        logsDataset: process.env.BQ_LOGS_DATASET ?? "logs",
      }),
    });
  }
  return globalThis.__bqa;
}

/** Convenience re-exports. */
export const track = (...args: Parameters<Analytics["track"]>) =>
  analytics().track(...args);
export const identify = (...args: Parameters<Analytics["identify"]>) =>
  analytics().identify(...args);
export const group = (...args: Parameters<Analytics["group"]>) =>
  analytics().group(...args);
export const log = (...args: Parameters<Analytics["log"]>) =>
  analytics().log(...args);
export const flush = () => analytics().flush();
