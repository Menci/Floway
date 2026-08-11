interface TimerHandle {
  unref(): void;
}

interface MaintenanceTimers {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  setInterval(callback: () => void, delayMs: number): TimerHandle;
}

// A startup tick prevents frequent restarts from starving maintenance. After
// that, minute cadence lets each bounded retention batch outpace sustained dump
// ingestion without concentrating writes into an hourly burst. Both timers are
// unreferenced so maintenance never keeps the Node process alive by itself.
const STARTUP_DELAY_MS = 30 * 1000;
const MAINTENANCE_INTERVAL_MS = 60 * 1000;

export const scheduleMaintenance = (
  runMaintenance: () => Promise<void>,
  timers: MaintenanceTimers,
): void => {
  const sweep = (): void => {
    runMaintenance().catch(err => {
      console.error('[scheduled-maintenance] sweep failed:', err);
    });
  };
  timers.setTimeout(sweep, STARTUP_DELAY_MS).unref();
  timers.setInterval(sweep, MAINTENANCE_INTERVAL_MS).unref();
};
