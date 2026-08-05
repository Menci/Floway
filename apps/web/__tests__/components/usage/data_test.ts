import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUsageOverviewQuery, loadUsagePageData, metricsFromWire } from '../../../src/components/usage/data';

afterEach(() => vi.unstubAllGlobals());

describe('usage response normalization', () => {
  it('indexes gateway metric rows by billing metric for chart consumers', () => {
    expect(metricsFromWire([
      { metric: 'input_tokens', quantity: '9007199254740993' },
      { metric: 'output_tokens', quantity: '42' },
    ])).toEqual({
      input_tokens: '9007199254740993',
      output_tokens: '42',
    });
  });
});

describe('buildUsageOverviewQuery', () => {
  it('uses the Performance overview query vocabulary', () => {
    const query = buildUsageOverviewQuery('7d', 'userId', {
      model: ['gpt-5', 'claude'],
      upstream: ['none'],
      userId: [],
      keyId: ['key-1'],
    }, Date.UTC(2026, 7, 5, 12));

    expect(query).toMatchObject({
      bucket: 'hour',
      group_by: 'userId',
      timezone: 'UTC',
      timezone_offset_minutes: '0',
      filter_model: ['gpt-5', 'claude'],
      filter_upstream: ['none'],
      filter_user_id: [],
      filter_key_id: ['key-1'],
    });
  });
});

it('threads navigation cancellation through every Usage page request', async () => {
  const controller = new AbortController();
  const request = new Request('http://localhost/dashboard/monitor/usage', { signal: controller.signal });
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost').pathname;
    if (path === '/api/token-usage/overview') return Response.json({
      series: [],
      axes: { none: [], model: [], upstream: [], userId: [], keyId: [] },
      dimensionValues: { models: [], upstreams: [], userIds: [], keyIds: [] },
      users: [],
      keys: [],
    });
    if (path === '/api/search-usage') return Response.json({ view: 'self-by-key', records: [], keys: [] });
    if (path === '/api/upstream-options') return Response.json([]);
    throw new Error(`Unexpected request to ${path}`);
  }));

  await loadUsagePageData(false, 'today', 'model', { model: [], upstream: [], userId: [], keyId: [] }, Date.UTC(2026, 7, 5, 12), request.signal);
  controller.abort();

  expect(signals).toHaveLength(3);
  expect(signals.every(signal => signal === request.signal && signal.aborted)).toBe(true);
});
