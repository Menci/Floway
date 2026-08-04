import type { DisplayUsageRecord, UsageFilters, UsageGroupBy } from './types';

const upstreamPrefix = 'upstream:';
const noUpstream = 'none';

export const usageUpstreamValue = (upstream: string | null): string =>
  upstream === null ? noUpstream : `${upstreamPrefix}${upstream}`;

export const upstreamFromUsageValue = (value: string): string | null => {
  if (value === noUpstream) return null;
  if (!value.startsWith(upstreamPrefix)) throw new TypeError(`Invalid Usage upstream dimension value: ${value}`);
  return value.slice(upstreamPrefix.length);
};

export const usageDimensionValue = (record: DisplayUsageRecord, dimension: UsageGroupBy): string => {
  if (dimension === 'identity') return record.keyId;
  if (dimension === 'model') return record.model;
  return usageUpstreamValue(record.upstream);
};

export const filterUsageRecords = (
  records: readonly DisplayUsageRecord[],
  filters: UsageFilters,
): DisplayUsageRecord[] => records.filter(record =>
  (filters.identity.length === 0 || filters.identity.includes(record.keyId))
  && (filters.model.length === 0 || filters.model.includes(record.model))
  && (filters.upstream.length === 0 || filters.upstream.includes(usageUpstreamValue(record.upstream))),
);

export const clearGroupedUsageFilter = (filters: UsageFilters, groupBy: UsageGroupBy): UsageFilters => ({
  ...filters,
  [groupBy]: [],
});
