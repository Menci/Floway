import type { Repo } from '../repo/types.ts';

export const createUpstreamUsageRecorder = (repo: Repo) => async (upstreamId: string, key: string, value: number, timestamp: number): Promise<void> => {
  if (key === '' || !Number.isFinite(value) || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError('Invalid upstream usage metric observation');
  const upstream = await repo.upstreams.getById(upstreamId);
  if (upstream === null) return;
  await repo.upstreamUsageMetrics.record({ upstreamId, key, value, timestamp, provider: upstream.kind, upstreamName: upstream.name, upstreamHue: upstream.hue });
};
