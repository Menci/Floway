import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { UsageHeatmapSection } from '../../../../src/components/usage/heatmap/section';
import { i18n } from '../../../../src/i18n';
import { stubLocalStorage } from '../../../local-storage-stub';
import { renderInApp } from '../../../render';
import { primeDefaultSession } from '../../../test-session';

stubLocalStorage();
beforeEach(() => { primeDefaultSession(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const NOW = Date.parse('2026-11-23T03:20:00Z');

const dayBucket = (day: string, model: string, requests: number, input: string) => {
  const row = { group: model, requests, cost: null, metrics: [{ metric: 'input_tokens', quantity: input }] };
  return {
    bucket: `${day}T00`, start: `${day}T00`, end: `${day}T23`,
    axes: { none: [{ ...row, group: 'all' }], model: [row], upstream: [], userId: [], keyId: [] },
    dimensionValues: { models: [model], upstreams: [], userIds: [], keyIds: [] },
  };
};

const stubHistory = (buckets: unknown[]) => vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
  if (url.pathname !== '/api/token-usage/overview') throw new Error(`Unexpected request: ${url.pathname}`);
  return Response.json({
    cursor: '2026-11-23T02', reset: true, start: url.searchParams.get('start'), end: url.searchParams.get('end'), buckets,
    scope: { actorId: 1, ownedKeyIds: [], visibility: 'all' },
    metadataVisibility: { complete: true, userIds: [], upstreamIds: [] },
    users: [], upstreams: [], keys: [],
  });
}));

const tile = (labelKey: string) => screen.getByText(i18n.t(labelKey)).parentElement!;

it('shows the records and a square per day of the last year', async () => {
  stubHistory([
    dayBucket('2026-11-20', 'gpt-5', 4, '2000000'),
    dayBucket('2026-11-21', 'claude-opus', 2, '9000000'),
    dayBucket('2026-11-22', 'gpt-5', 1, '1000000'),
  ]);
  renderInApp(<UsageHeatmapSection refreshedAt={NOW} />);

  await waitFor(() => expect(tile('monitoring.usage.heatmap.records.total').textContent).toContain('12M'));
  expect(tile('monitoring.usage.heatmap.records.total').textContent).toContain('Since Nov 20, 2026');
  expect(tile('monitoring.usage.heatmap.records.activeDays').textContent).toContain('3 days');
  expect(tile('monitoring.usage.heatmap.records.currentStreak').textContent).toContain('3 days');
  expect(tile('monitoring.usage.heatmap.records.peakDay').textContent).toContain('9M');
  expect(tile('monitoring.usage.heatmap.records.topModel').textContent).toContain('claude-opus');
  expect(tile('monitoring.usage.heatmap.records.topModel').textContent).toContain('75% of all tokens');
  expect(screen.getByText('12M tokens in the last year')).toBeTruthy();

  const cells = screen.getAllByRole('img').filter(element => element.dataset.ordinal !== undefined);
  expect(cells).toHaveLength(52 * 7 + 1);
  const busiest = screen.getByRole('img', { name: 'Saturday, November 21, 2026: 9,000,000 tokens' });
  expect(busiest.dataset.level).toBe('4');
  expect(screen.getByRole('img', { name: 'Sunday, November 22, 2026: 1,000,000 tokens' }).dataset.level).toBe('1');
  expect(screen.getByRole('img', { name: 'Monday, November 23, 2026: No usage' }).dataset.level).toBe('0');

  fireEvent.pointerOver(busiest);
  expect(await screen.findByText('Mostly claude-opus')).toBeTruthy();
  expect(screen.getByText('2 requests')).toBeTruthy();
});

it('says the view is unavailable rather than drawing an empty year when the history cannot be read', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Usage store unavailable' }, { status: 503 })));
  renderInApp(<UsageHeatmapSection refreshedAt={NOW} />);

  expect(await screen.findByText(i18n.t('common.errors.viewUnavailable'))).toBeTruthy();
  expect(screen.queryAllByRole('img').filter(element => element.dataset.ordinal !== undefined)).toHaveLength(0);
});
