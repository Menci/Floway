import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useTelemetryPolling } from '../../../src/components/telemetry/use-poll';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const setup = () => {
  vi.stubEnv('TZ', 'UTC');
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
};

test('historical Custom does not poll or refresh when returning to the tab', async () => {
  setup(); vi.setSystemTime(Date.UTC(2026, 9, 10));
  const poll = vi.fn().mockResolvedValue(undefined);
  renderHook(() => useTelemetryPolling(poll, { start: '2026-10-01', end: '2026-10-09' }, true));
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  document.dispatchEvent(new Event('visibilitychange'));
  expect(poll).not.toHaveBeenCalled();
});

test('a fixed Custom polls while current and stops after its last day', async () => {
  setup(); vi.setSystemTime(Date.UTC(2026, 9, 10, 23, 58, 30));
  const poll = vi.fn().mockResolvedValue(undefined);
  renderHook(() => useTelemetryPolling(poll, { start: '2026-10-10', end: '2026-10-10' }, true));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(poll).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  expect(poll).toHaveBeenCalledTimes(1);
});

test('a future Custom begins polling when its fixed days reach the current time', async () => {
  setup(); vi.setSystemTime(Date.UTC(2026, 9, 10, 23, 59, 30));
  const poll = vi.fn().mockResolvedValue(undefined);
  renderHook(() => useTelemetryPolling(poll, { start: '2026-10-11', end: '2026-10-11' }, true));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(poll).toHaveBeenCalledTimes(1);
});
