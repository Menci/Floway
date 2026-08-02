import { useSyncExternalStore } from 'react';

// Snapshots are quantized to the interval: an unrounded Date.now() never settles.
export const useNow = (intervalMs: number): number => useSyncExternalStore(
  onChange => {
    const timer = window.setInterval(onChange, intervalMs);
    return () => window.clearInterval(timer);
  },
  () => Math.floor(Date.now() / intervalMs) * intervalMs,
  () => 0,
);
