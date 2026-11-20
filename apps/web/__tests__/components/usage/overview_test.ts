import { expect, test } from 'vitest';

import { mergeUsageOverview, usageOverviewCursor, usageOverviewForDisplay } from '../../../src/components/usage/overview';
import type { TokenUsageOverviewBucket, TokenUsageOverviewResponse } from '@floway-dev/gateway/browser';

const bucket = (
  start: string, end: string, group: string, requests: number, cost: `${number}` | null,
): TokenUsageOverviewBucket => {
  const row = { group, requests, metrics: [{ metric: 'input_tokens', quantity: '9007199254740992.1' }] as const, cost };
  return {
    start, end, bucket: start.slice(0, 10),
    axes: {
      none: [{ ...row, group: 'all', metrics: [...row.metrics] }],
      model: [{ ...row, metrics: [...row.metrics] }],
      keyId: [], upstream: [], userId: [],
    },
    dimensionValues: { models: [group], keyIds: [], upstreams: [], userIds: [] },
  };
};

test('a rolling overview replaces overlapping hours and adds the remaining intervals exactly', () => {
  const baseline: TokenUsageOverviewResponse = {
    cursor: 'before', reset: true, start: '2026-04-29T00', end: '2026-04-30T15',
    buckets: [
      bucket('2026-04-29T04', '2026-04-29T18', 'expired', 100, '100'),
      bucket('2026-04-30T12', '2026-04-30T13', 'model-a', 1, null),
      bucket('2026-04-30T13', '2026-04-30T14', 'model-b', 99, '99'),
    ],
    visibleUserIds: [], visibleUpstreamIds: [], keys: [], upstreams: [], users: [],
  };
  const start = '2026-04-30T00';
  const delta: TokenUsageOverviewResponse = {
    ...baseline, cursor: 'after', reset: false, start: '2026-04-30T13', end: '2026-05-02T10',
    buckets: [
      bucket('2026-04-30T13', '2026-04-30T14', 'model-b', 2, '0.125'),
      bucket('2026-05-01T04', '2026-05-01T18', 'model-a', 1, '0.125'),
      bucket('2026-05-02T09', '2026-05-02T10', 'model-b', 1, '0'),
    ],
  };
  expect(usageOverviewCursor(baseline, start, delta.end)).toBe('before');
  expect(usageOverviewCursor(baseline, '2026-04-29T12', delta.end)).toBeUndefined();
  const snapshot = mergeUsageOverview(baseline, delta, start);
  expect(mergeUsageOverview(snapshot, delta, start)).toEqual(snapshot);
  const usage = usageOverviewForDisplay(snapshot, 'model');
  expect(usage.series.map(({ bucket, group, requests }) => [bucket, group, requests])).toEqual([
    ['2026-04-30', 'model-a', 1], ['2026-04-30', 'model-b', 2],
    ['2026-05-01', 'model-a', 1], ['2026-05-02', 'model-b', 1],
  ]);
  expect(usage.axes.none[0]).toMatchObject({ requests: 5, cost: '0.25', metrics: { input_tokens: '36028797018963968.4' } });
  expect(usage.axes.model.map(({ group, requests }) => [group, requests])).toEqual([['model-a', 2], ['model-b', 3]]);
  expect(usage.dimensionValues.models).toEqual(['model-a', 'model-b']);
});
