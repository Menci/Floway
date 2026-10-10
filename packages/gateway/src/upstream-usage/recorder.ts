import type { Repo } from '../repo/types.ts';

export const createUpstreamUsageRecorder = (repo: Repo) => async (upstreamId: string, key: string, value: number, timestamp: number): Promise<void> => {
  if (key === '' || !Number.isFinite(value) || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError('Invalid upstream usage metric observation');
  await repo.upstreamUsageMetrics.record({ upstreamId, key, value, timestamp });
};
