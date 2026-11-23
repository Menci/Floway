import { useSyncExternalStore } from 'react';

// Snapshots are quantized to the interval: an unrounded Date.now() never settles.
const idle = () => () => {};
const zero = () => 0;

export const useNow = (intervalMs: number, enabled = true): number => useSyncExternalStore(
  enabled ? onChange => {
    const timer = window.setInterval(onChange, intervalMs);
    return () => window.clearInterval(timer);
  } : idle,
  enabled ? () => Math.floor(Date.now() / intervalMs) * intervalMs : zero,
  zero,
);
