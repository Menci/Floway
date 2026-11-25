import type { UpstreamRecord } from './model.ts';
import type { Fetcher } from './options.ts';

export interface ProviderScheduledOptions<Send = Fetcher> {
  fetcher: (record: UpstreamRecord) => Promise<Send | null>;
}

export const runScheduledUsageRefresh = async <Send>(
  record: UpstreamRecord,
  options: ProviderScheduledOptions<Send>,
  lastObservedAt: number | null,
  refresh: (record: UpstreamRecord, fetcher: Send) => Promise<unknown>,
): Promise<void> => {
  const now = Date.now();
  const intervalMs = record.usageRefreshIntervalMinutes * 60_000;
  if (!record.enabled || !record.usageRefreshIntervalMinutes
    || (lastObservedAt !== null && now - lastObservedAt < intervalMs)) return;
  const fetcher = await options.fetcher(record);
  if (fetcher === null) return;
  await refresh(record, fetcher);
};
