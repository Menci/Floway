import type { UpstreamRecord } from './model.ts';
import type { Fetcher } from './options.ts';

export interface UpstreamScheduledOptions {
  fetcher: (record: UpstreamRecord) => Promise<Fetcher | null>;
}

export const runScheduledUsageRefresh = async (
  record: UpstreamRecord,
  options: UpstreamScheduledOptions,
  lastObservedAt: number | null,
  refresh: (record: UpstreamRecord, fetcher: Fetcher) => Promise<unknown>,
): Promise<void> => {
  const now = Date.now();
  const intervalMs = record.usageRefreshIntervalMinutes * 60_000;
  if (!record.enabled || !record.usageRefreshIntervalMinutes
    || (lastObservedAt !== null && now - lastObservedAt < intervalMs)) return;
  const fetcher = await options.fetcher(record);
  if (fetcher === null) return;
  await refresh(record, fetcher);
};
