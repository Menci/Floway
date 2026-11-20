import { expect, test, vi } from 'vitest';

import { dashboardRangeQuery } from '../../../src/components/charts/dashboard-time';
import { createUsageOverviewLoader } from '../../../src/components/usage/data';
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
    actorId: 1, isAdmin: false, visibleUserIds: [], visibleUpstreamIds: [], keys: [], upstreams: [], users: [],
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

test('Usage keeps a baseline across metadata and display changes and replaces it on revocation', async () => {
  const loadedAt = Date.UTC(2026, 3, 30, 14, 20);
  const { start, end } = dashboardRangeQuery('30d', loadedAt);
  const cursor = '2026-04-30T13';
  const initial: TokenUsageOverviewResponse = {
    start, end, cursor, reset: true, actorId: 1, isAdmin: false,
    buckets: [bucket('2026-04-29T04', '2026-04-29T05', 'model-a', 4, null)],
    visibleUserIds: [1, 2], visibleUpstreamIds: [], keys: [], upstreams: [],
    users: [{ id: 1, username: 'operator' }, { id: 2, username: 'before' }],
  };
  const renamed: TokenUsageOverviewResponse = {
    ...initial, reset: false, start: cursor, buckets: [], visibleUserIds: [2, 1],
    users: [{ id: 1, username: 'operator' }, { id: 2, username: 'after' }],
  };
  const reduced = { ...renamed, visibleUserIds: [1], users: renamed.users.slice(0, 1) };
  const responses = [initial, renamed, reduced, { ...reduced, start, reset: true }];
  const cursors: Array<string | null> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    cursors.push(url.searchParams.get('cursor'));
    const response = responses.shift();
    if (!response) throw new Error('Unexpected Usage request');
    return Response.json(response);
  }));
  try {
    const load = createUsageOverviewLoader();
    const filters = { model: ['model-a', 'model-b'], userId: [], upstream: [], keyId: [] };
    const signal = new AbortController().signal;
    expect((await load('30d', 'model', filters, loadedAt, signal)).data?.axes.none[0]?.requests).toBe(4);
    const next = await load('30d', 'upstream', { ...filters, model: ['model-b', 'model-a'] }, loadedAt, signal);
    expect(next.data?.axes.none[0]?.requests).toBe(4);
    expect(next.data?.users.at(-1)?.username).toBe('after');
    expect((await load('30d', 'upstream', filters, loadedAt, signal)).data?.axes.none).toEqual([]);
    expect(cursors).toEqual([null, cursor, cursor, null]);
  } finally {
    vi.unstubAllGlobals();
  }
});
