import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useTelemetryPolling } from '../../../src/components/telemetry/use-poll';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const setup = () => {
  vi.stubEnv('TZ', 'UTC');
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
};

test('a fixed Custom polls while current and stops after its last day', async () => {
  setup(); vi.setSystemTime(Date.UTC(2026, 9, 10, 23, 54, 30));
  const poll = vi.fn().mockResolvedValue(undefined);
  renderHook(() => useTelemetryPolling(poll, { start: '2026-10-10', end: '2026-10-10' }, true));
  await act(() => vi.advanceTimersByTimeAsync(299_999));
  expect(poll).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(poll).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(600_000));
  expect(poll).toHaveBeenCalledTimes(1);
});
