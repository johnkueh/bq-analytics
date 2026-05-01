// Tiny visibility singleton — lets `useReleaseNotes()` and
// `<ReleaseNotesPrompt>` coordinate without prop-drilling.
//
// On manual open: `useReleaseNotes().open()` calls `show(true)`.
// `<ReleaseNotesPrompt>` subscribes via `useSyncExternalStore` and
// re-renders with the new visibility.

import { useSyncExternalStore } from "react";

let visible = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setVisibleSingleton(next: boolean): void {
  if (visible === next) return;
  visible = next;
  emit();
}

export function getVisibleSingleton(): boolean {
  return visible;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    getVisibleSingleton,
    getVisibleSingleton,
  );
}

/** Test-only helper. */
export function __resetVisibility(): void {
  visible = false;
  listeners.clear();
}
