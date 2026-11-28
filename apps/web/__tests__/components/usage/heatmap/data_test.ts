import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createUsageHistoryLoader, summarizeUsageHistory, usageHistoryStart } from '../../../../src/components/usage/heatmap/data';
import { stubLocalStorage } from '../../../local-storage-stub';
import { primeDefaultSession } from '../../../test-session';
import { telemetryDayOrdinal } from '@floway-dev/protocols/browser';

stubLocalStorage();
beforeEach(() => { primeDefaultSession(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const NOW = Date.parse('2026-11-23T03:20:00Z');

const row = (group: string, requests: number, input: string, output: string) => ({
  group, requests, cost: null,
  metrics: [{ metric: 'input_tokens', quantity: input }, { metric: 'output_tokens', quantity: output }],
});
type Row = ReturnType<typeof row>;
// Each bucket is keyed by the start hour of its 24-hour span. The overview
// reports the span that holds its resume hours hour by hour, so one day can
// arrive as several buckets under the same key.
const bucket = (span: string, start: string, end: string, rows: Row[]) => ({
  bucket: span, start, end,
  axes: {
    none: rows.map(entry => ({ ...entry, group: 'all' })),
    model: rows,
    upstream: [], userId: [], keyId: [],
  },
  dimensionValues: { models: rows.map(entry => entry.group), upstreams: [], userIds: [], keyIds: [] },
});
const overview = (fields: { cursor: string; reset: boolean; start: string; end: string; buckets: unknown[]; actorId?: number }) => ({
  cursor: fields.cursor, reset: fields.reset, start: fields.start, end: fields.end, buckets: fields.buckets,
  scope: { actorId: fields.actorId ?? 1, ownedKeyIds: [], visibility: 'all' },
  metadataVisibility: { complete: true, userIds: [], upstreamIds: [] },
  users: [], upstreams: [], keys: [],
});

const stubOverview = (responses: Array<(query: URLSearchParams) => unknown>) => {
  const queries: URLSearchParams[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname !== '/api/token-usage/overview') throw new Error(`Unexpected request: ${url.pathname}`);
    queries.push(url.searchParams);
    const respond = responses[queries.length - 1];
    if (respond === undefined) throw new Error('No overview response left');
    return Response.json(respond(url.searchParams));
  }));
  return queries;
};

const firstSnapshot = (query: URLSearchParams) => overview({
  cursor: '2026-11-23T02', reset: true, start: query.get('start')!, end: query.get('end')!,
  buckets: [
    bucket('2026-11-21T00', '2026-11-21T00', '2026-11-22T00', [row('gpt-5', 2, '100', '50'), row('claude-opus', 1, '300', '0')]),
    bucket('2026-11-23T00', '2026-11-23T01', '2026-11-23T02', [row('gpt-5', 1, '10', '5')]),
    bucket('2026-11-23T00', '2026-11-23T02', '2026-11-23T03', [row('gpt-5', 1, '20', '5')]),
  ],
});

it('reads the whole history in local days and sums each day across its buckets', async () => {
  const queries = stubOverview([firstSnapshot]);

  const result = await createUsageHistoryLoader()(NOW, new AbortController().signal);
  if (result.error) throw new Error(result.error.message);

  expect(queries).toHaveLength(1);
  expect(Object.fromEntries(queries[0]!)).toMatchObject({
    start: '1970-01-01T00', end: '2026-11-23T04', format: 'fixed-buckets', bucket: 'day', group_by: 'model',
  });
  expect(queries[0]!.has('cursor')).toBe(false);
  expect(queries[0]!.has('timezone')).toBe(false);
  const { days, tokens, requests, models } = result.data;
  expect(days.get(telemetryDayOrdinal('2026-11-21'))).toEqual({
    ordinal: telemetryDayOrdinal('2026-11-21'), date: '2026-11-21', tokens: '450', requests: 3, topModel: 'claude-opus',
  });
  expect(days.get(telemetryDayOrdinal('2026-11-23'))).toMatchObject({ tokens: '40', requests: 2, topModel: 'gpt-5' });
  expect(days.has(telemetryDayOrdinal('2026-11-22'))).toBe(false);
  expect({ tokens, requests }).toEqual({ tokens: '490', requests: 5 });
  expect(models).toEqual([{ model: 'claude-opus', tokens: '300' }, { model: 'gpt-5', tokens: '190' }]);
});

it('resumes from the cursor and replaces only the hours it rescanned', async () => {
  const queries = stubOverview([
    firstSnapshot,
    query => overview({
      cursor: '2026-11-23T03', reset: false, start: query.get('cursor')!, end: query.get('end')!,
      buckets: [
        bucket('2026-11-23T00', '2026-11-23T02', '2026-11-23T03', [row('gpt-5', 2, '60', '5')]),
        bucket('2026-11-23T00', '2026-11-23T03', '2026-11-23T04', [row('gpt-5', 1, '1', '1')]),
      ],
    }),
  ]);
  const load = createUsageHistoryLoader();

  await load(NOW, new AbortController().signal);
  const result = await load(NOW + 3_600_000, new AbortController().signal);
  if (result.error) throw new Error(result.error.message);

  expect(queries[1]!.get('cursor')).toBe('2026-11-23T02');
  expect(result.data.days.get(telemetryDayOrdinal('2026-11-23'))).toMatchObject({ tokens: '82', requests: 4 });
  expect(result.data.days.get(telemetryDayOrdinal('2026-11-21'))).toMatchObject({ tokens: '450' });
});

it('starts over when the visible scope changed between reads', async () => {
  const queries = stubOverview([
    firstSnapshot,
    query => overview({ cursor: '2026-11-23T03', reset: false, start: query.get('cursor')!, end: query.get('end')!, buckets: [], actorId: 2 }),
    query => overview({ cursor: '2026-11-23T03', reset: true, start: query.get('start')!, end: query.get('end')!, buckets: [], actorId: 2 }),
  ]);
  const load = createUsageHistoryLoader();

  await load(NOW, new AbortController().signal);
  const result = await load(NOW, new AbortController().signal);
  if (result.error) throw new Error(result.error.message);

  expect(queries.map(query => query.get('cursor'))).toEqual([null, '2026-11-23T02', null]);
  expect(result.data.days.size).toBe(0);
});

it('hands back the request failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Usage store unavailable' }, { status: 503 })));

  const result = await createUsageHistoryLoader()(NOW, new AbortController().signal);

  expect(result.error?.status).toBe(503);
});

it('starts the spans at local midnight and names each by the local date at its midpoint', () => {
  vi.stubEnv('TZ', 'America/New_York');
  const summer = Date.parse('2026-07-15T12:00:00Z');
  // Local midnight in EDT is 04:00 UTC.
  expect(usageHistoryStart(summer)).toBe('1970-01-01T04');
  const winter = Date.parse('2026-01-15T12:00:00Z');
  expect(usageHistoryStart(winter)).toBe('1970-01-01T05');

  // With a summer start, a January span runs from 23:00 EST the evening
  // before; it still belongs to the day it mostly covers.
  const { days } = summarizeUsageHistory(overview({
    cursor: '2026-07-15T12', reset: true, start: '1970-01-01T04', end: '2026-07-15T13',
    buckets: [
      bucket('2026-01-10T04', '2026-01-10T04', '2026-01-11T04', [row('gpt-5', 1, '10', '0')]),
      bucket('2026-07-14T04', '2026-07-14T04', '2026-07-15T04', [row('gpt-5', 1, '20', '0')]),
    ],
  }) as Parameters<typeof summarizeUsageHistory>[0]);
  expect([...days.values()].map(day => [day.date, day.tokens])).toEqual([['2026-01-10', '10'], ['2026-07-14', '20']]);
});

it('rounds a local midnight that falls inside a UTC hour up to the next hour', () => {
  vi.stubEnv('TZ', 'Asia/Kolkata');
  // Local midnight in IST is 18:30 UTC the day before.
  expect(usageHistoryStart(Date.parse('2026-11-23T03:20:00Z'))).toBe('1970-01-01T19');
});
