import type { ResetCycleHistory } from '../../../src/components/telemetry/reset-cycles';

export const resetHistory = (at: number, upstreamId = 'up-1'): ResetCycleHistory => ({
  upstreamId, supported: true,
  metrics: ([
    ['five_hour', 18_000, [3, 8, 13, 18]],
    ['seven_day', 604_800, [72, 240, 408]],
  ] as const).map(([quota, windowSeconds, hours]) => ({
    identity: { name: 'quota.utilization', labels: { quota } },
    display: { name: quota, labelKey: 'monitoring.upstreams.series.remaining', windowSeconds },
    starts: hours.map(hour => at - hour * 3_600_000 + 10 * 60_000),
  })),
});
