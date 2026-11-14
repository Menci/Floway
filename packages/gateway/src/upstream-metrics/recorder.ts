import type { Repo } from '../repo/types.ts';
import type { UpstreamMetricLabels } from '@floway-dev/provider';

export const createUpstreamMetricsRecorder = (repo: Repo) => async (upstreamId: string, name: string, labels: UpstreamMetricLabels, value: number, timestamp: number): Promise<void> => {
  if (!Number.isFinite(value) || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError('Invalid upstream metric observation');
  await repo.upstreamMetrics.record({ upstreamId, name, labels, value, timestamp });
};
