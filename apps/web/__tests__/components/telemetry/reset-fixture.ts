import type { UpstreamResetCycles } from '../../../src/components/telemetry/reset-cycles';

export const resetLoadedAt = Date.UTC(2026, 10, 11, 12, 30);
export const resetCycles: UpstreamResetCycles = {
  upstreamId: 'up-1', available: true,
  metrics: [
    {
      identity: { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: 18_000 } },
      display: { name: '', labelKey: 'dashboard.upstreamMetrics.metrics.remaining', windowSeconds: 18_000 },
      currentStart: Date.UTC(2026, 10, 11, 10, 15), previousStart: Date.UTC(2026, 10, 11, 5, 15),
    },
    {
      identity: { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: 604_800 } },
      display: { name: '', labelKey: 'dashboard.upstreamMetrics.metrics.remaining', windowSeconds: 604_800 },
      currentStart: Date.UTC(2026, 10, 9, 9, 45), previousStart: Date.UTC(2026, 10, 2, 9, 45),
    },
  ],
};
