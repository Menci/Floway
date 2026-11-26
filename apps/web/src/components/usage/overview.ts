import type { DisplayUsageRecord, UsageGroupBy, UsageOverviewResponse } from './types';
import type { TokenUsageOverviewBucket, TokenUsageOverviewResponse } from '@floway-dev/gateway/browser';
import { addDecimalStrings, usageUpstreamFromDimensionValue } from '@floway-dev/protocols/browser';

type UsageAxis = keyof TokenUsageOverviewBucket['axes'];

const sumAxis = (buckets: readonly TokenUsageOverviewBucket[], axis: UsageAxis, series: boolean): DisplayUsageRecord[] => {
  const rows = new Map<string, DisplayUsageRecord>();
  for (const bucket of buckets) {
    const period = series ? bucket.bucket : 'all';
    for (const row of bucket.axes[axis]) {
      const id = JSON.stringify([period, row.group]);
      let aggregate = rows.get(id);
      if (aggregate === undefined) {
        aggregate = { bucket: period, group: row.group, requests: 0, metrics: {}, cost: null };
        rows.set(id, aggregate);
      }
      aggregate.requests += row.requests;
      if (!Number.isSafeInteger(aggregate.requests)) throw new RangeError('Usage overview requests exceed the safe integer range');
      for (const { metric, quantity } of row.metrics) {
        aggregate.metrics[metric] = addDecimalStrings(aggregate.metrics[metric] ?? '0', quantity);
      }
      if (row.cost !== null) aggregate.cost = addDecimalStrings(aggregate.cost ?? '0', row.cost);
    }
  }
  return [...rows.values()].sort((left, right) => left.bucket.localeCompare(right.bucket) || left.group.localeCompare(right.group));
};

const union = (values: readonly string[]): string[] => [...new Set(values)].sort();

export const usageOverviewForDisplay = (data: TokenUsageOverviewResponse, groupBy: UsageGroupBy): UsageOverviewResponse => {
  const { buckets } = data;
  const dimensionValues = {
    keyIds: union(buckets.flatMap(bucket => bucket.dimensionValues.keyIds)),
    userIds: [...new Set(buckets.flatMap(bucket => bucket.dimensionValues.userIds))].sort((left, right) => left - right),
    models: union(buckets.flatMap(bucket => bucket.dimensionValues.models)),
    upstreams: union(buckets.flatMap(bucket => bucket.dimensionValues.upstreams)),
  };
  const userIds = new Set([...data.metadataVisibility.userIds, ...dimensionValues.userIds]);
  const upstreamIds = new Set([...data.metadataVisibility.upstreamIds, ...dimensionValues.upstreams.map(usageUpstreamFromDimensionValue)]);
  const users = data.users.filter(user => userIds.has(user.id)).sort((left, right) => left.id - right.id);
  return {
    series: sumAxis(buckets, groupBy, true),
    axes: {
      none: sumAxis(buckets, 'none', false),
      keyId: sumAxis(buckets, 'keyId', false),
      userId: sumAxis(buckets, 'userId', false),
      model: sumAxis(buckets, 'model', false),
      upstream: sumAxis(buckets, 'upstream', false),
    },
    dimensionValues,
    users,
    auditableUserIds: users.map(user => user.id),
    upstreams: data.upstreams.filter(upstream => upstreamIds.has(upstream.id)).sort((left, right) => left.id.localeCompare(right.id)),
    keys: data.keys,
  };
};
