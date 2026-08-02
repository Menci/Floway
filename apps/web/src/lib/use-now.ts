import { useSyncExternalStore } from 'react';

// The wall clock is an external mutable source, so reading it during render is
// impure. Subscribing gives every consumer one coherent reading per tick.
export const useNow = (intervalMs: number): number => useSyncExternalStore(
  onChange => {
    const timer = window.setInterval(onChange, intervalMs);
    return () => window.clearInterval(timer);
  },
  () => Math.floor(Date.now() / intervalMs) * intervalMs,
  () => 0,
);
