import { afterEach, expect, test, vi } from 'vitest';

import { resetHistory } from './reset-fixture';
import { loadWithResetCycles, resetRangeAt } from '../../../src/components/telemetry/reset-cycles';

const loadedAt = Date.UTC(2026, 9, 10, 14, 30);
afterEach(() => vi.unstubAllGlobals());

test('a newly observed reset advances the current cycle but leaves the applied historical cycle fixed', async () => {
  const history = resetHistory(loadedAt);
  const [metric] = history.metrics;
  const nextStart = loadedAt + 60_000;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    ...history, metrics: [{ ...metric, starts: [nextStart, ...metric!.starts] }],
  })));
  const load = vi.fn(async range => range);
  const signal = new AbortController().signal;
  const current = await loadWithResetCycles(history.upstreamId, resetRangeAt(history.upstreamId, metric!, 0)!, nextStart + 1, signal, load);
  expect(current.range).toMatchObject({ start: nextStart, end: null });
  expect(current.data).toBe(current.range);

  const previous = resetRangeAt(history.upstreamId, metric!, 1)!;
  const historical = await loadWithResetCycles(history.upstreamId, previous, nextStart + 1, signal, load);
  expect(historical.range).toBe(previous);
  expect(historical.data).toBe(previous);
});

test('a history request failure cannot silently substitute a calendar range', async () => {
  const history = resetHistory(loadedAt);
  const range = resetRangeAt(history.upstreamId, history.metrics[0]!, 0)!;
  const fetchHistory = vi.fn(async () => Response.json({ error: 'History unavailable' }, { status: 500 }));
  vi.stubGlobal('fetch', fetchHistory);
  const signal = new AbortController().signal;
  const load = vi.fn(async () => 'observations');
  await expect(loadWithResetCycles(history.upstreamId, range, loadedAt, signal, load)).resolves.toMatchObject({
    data: null, range, error: { message: 'History unavailable' },
  });
  expect(load).not.toHaveBeenCalled();
  await expect(loadWithResetCycles(history.upstreamId, '7d', loadedAt, signal, load)).resolves.toMatchObject({
    data: 'observations', range: '7d', error: null,
  });
  expect(fetchHistory).toHaveBeenCalledTimes(1);
});
