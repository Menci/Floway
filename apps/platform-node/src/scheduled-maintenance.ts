import { runScheduledMaintenance } from '@floway-dev/gateway';

interface TimerHandle {
  unref(): void;
}

interface MaintenanceTimers {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  setInterval(callback: () => void, delayMs: number): TimerHandle;
}

// The startup tick avoids waiting the full interval when a process stays alive
// for at least 30 seconds. Minute cadence increases bounded cleanup throughput
// and spreads its writes across the hour. Both timers are unreferenced so
// maintenance never keeps the Node process alive by itself.
const STARTUP_DELAY_MS = 30 * 1000;
const MAINTENANCE_INTERVAL_MS = 60 * 1000;

export const startScheduledMaintenance = (
  runMaintenance: () => Promise<void> = runScheduledMaintenance,
  timers: MaintenanceTimers = { setTimeout, setInterval },
): void => {
  const sweep = (): void => {
    runMaintenance().catch(err => {
      console.error('[scheduled-maintenance] sweep failed:', err);
    });
  };
  timers.setTimeout(sweep, STARTUP_DELAY_MS).unref();
  timers.setInterval(sweep, MAINTENANCE_INTERVAL_MS).unref();
};
