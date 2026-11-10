import { afterEach, expect, it, vi } from 'vitest';

import { resetCycles, resetLoadedAt } from './reset-fixture';
import { dashboardInterval, dashboardRangeIsCurrent, parseDashboardRange, serializeDashboardRange } from '../../../src/components/charts/dashboard-time';
import { loadTelemetryResetCycles, resetCycleRange, singleTelemetryUpstream } from '../../../src/components/telemetry/reset-cycles';

afterEach(() => vi.unstubAllGlobals());

it('requires exactly one concrete upstream for reset cycles', () => {
  expect(singleTelemetryUpstream([], 'usage')).toBeNull();
  expect(singleTelemetryUpstream(['none'], 'usage')).toBeNull();
  expect(singleTelemetryUpstream(['upstream:up-1', 'upstream:up-2'], 'usage')).toBeNull();
  expect(singleTelemetryUpstream(['upstream:up-1'], 'usage')).toBe('up-1');
  expect(singleTelemetryUpstream(['up-1'], 'performance')).toBe('up-1');
  expect(singleTelemetryUpstream(['up-1', 'up-2'], 'performance')).toBeNull();
});

it('makes hourly statistics disjoint at the observed reset hour and keeps both cycles polling', () => {
  const metric = resetCycles.metrics[0]!;
  const current = resetCycleRange(resetCycles, metric, 'current', resetLoadedAt)!;
  const previous = resetCycleRange(resetCycles, metric, 'previous', resetLoadedAt)!;
  expect(dashboardInterval(previous, resetLoadedAt)).toEqual({ start: Date.UTC(2026, 10, 11, 5), end: Date.UTC(2026, 10, 11, 10) });
  expect(dashboardInterval(current, resetLoadedAt)).toEqual({ start: Date.UTC(2026, 10, 11, 10), end: Date.UTC(2026, 10, 11, 13) });
  expect(dashboardRangeIsCurrent(previous, resetLoadedAt)).toBe(true);
  const search = new URLSearchParams();
  serializeDashboardRange(search, previous);
  expect(parseDashboardRange(search)).toEqual(previous);
});

it('withholds periods without observed boundaries or an hourly span', () => {
  const metric = resetCycles.metrics[0]!;
  expect(resetCycleRange(resetCycles, { ...metric, currentStart: null, previousStart: null }, 'current', resetLoadedAt)).toBeNull();
  expect(resetCycleRange(resetCycles, { ...metric, previousStart: null }, 'previous', resetLoadedAt)).toBeNull();
  expect(resetCycleRange(resetCycles, { ...metric, previousStart: metric.currentStart! - 60_000 }, 'previous', resetLoadedAt)).toBeNull();
});

it('refreshes cycle boundaries from the server instead of trusting a bookmarked interval', async () => {
  const range = resetCycleRange(resetCycles, resetCycles.metrics[0]!, 'previous', resetLoadedAt)!;
  const moved = { ...resetCycles, metrics: [{ ...resetCycles.metrics[0]!, previousStart: resetCycles.metrics[0]!.currentStart, currentStart: Date.UTC(2026, 10, 11, 12) }] };
  const fetch = vi.fn(async () => Response.json(moved));
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  const result = await loadTelemetryResetCycles('up-1', range, resetLoadedAt, signal);
  expect(result.data?.range).toMatchObject({ cycle: 'previous', start: moved.metrics[0]!.previousStart, end: moved.metrics[0]!.currentStart });
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/upstream-reset-cycles?'), expect.objectContaining({ signal }));
});

it('leaves reset mode after widening or changing upstream scope and propagates telemetry failures', async () => {
  const range = resetCycleRange(resetCycles, resetCycles.metrics[0]!, 'current', resetLoadedAt)!;
  const fetch = vi.fn(async () => Response.json({ ...resetCycles, upstreamId: 'up-2' }));
  vi.stubGlobal('fetch', fetch);
  expect((await loadTelemetryResetCycles(null, range, resetLoadedAt)).data).toEqual({ range: 'today', resetCycles: null });
  expect(fetch).not.toHaveBeenCalled();
  expect((await loadTelemetryResetCycles('up-2', range, resetLoadedAt)).data?.range).toBe('today');
  const cause = new Error('Telemetry unavailable');
  fetch.mockRejectedValueOnce(cause);
  expect((await loadTelemetryResetCycles('up-1', range, resetLoadedAt)).error).toMatchObject({ message: cause.message, cause });
});
