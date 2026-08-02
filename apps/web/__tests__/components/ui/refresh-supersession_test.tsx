import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useRefresh } from '../../../src/components/ui/use-refresh';

interface Run { background: boolean; settle: () => void; signal: AbortSignal }

// Every run is held open until the test settles it by hand, so a suite can put
// two of them in flight at once and choose which order they come back in.
const renderRefresh = () => {
  const runs: Run[] = [];
  const reload = (signal: AbortSignal, { background }: { background: boolean }) =>
    new Promise<void>(resolve => { runs.push({ background, settle: resolve, signal }); });
  return { runs, ...renderHook(() => useRefresh(reload)) };
};

describe('refresh supersession', () => {
  it('aborts the run a newer one supersedes', async () => {
    const { result, runs } = renderRefresh();

    await act(async () => { void result.current.refresh(); });
    await act(async () => { void result.current.refresh(); });

    expect(runs).toHaveLength(2);
    expect(runs[0]?.signal.aborted).toBe(true);
    expect(runs[1]?.signal.aborted).toBe(false);
  });

  it('stays refreshing when a superseded run settles before the newest one', async () => {
    const { result, runs } = renderRefresh();

    await act(async () => { void result.current.refresh(); });
    await act(async () => { void result.current.refresh(); });
    await act(async () => { runs[0]?.settle(); });

    expect(result.current.refreshing).toBe(true);

    await act(async () => { runs[1]?.settle(); });

    expect(result.current.refreshing).toBe(false);
  });

  it('stops refreshing once the newest run settles, whatever the superseded one does after', async () => {
    const { result, runs } = renderRefresh();

    await act(async () => { void result.current.refresh(); });
    await act(async () => { void result.current.refresh(); });
    await act(async () => { runs[1]?.settle(); });

    expect(result.current.refreshing).toBe(false);

    await act(async () => { runs[0]?.settle(); });

    expect(result.current.refreshing).toBe(false);
  });

  it('aborts the run still in flight when the page unmounts', async () => {
    const { result, runs, unmount } = renderRefresh();

    await act(async () => { void result.current.refresh(); });
    expect(runs[0]?.signal.aborted).toBe(false);

    unmount();

    expect(runs[0]?.signal.aborted).toBe(true);
  });

  it('tells the reload whether anybody asked for the run', async () => {
    const { result, runs } = renderRefresh();

    await act(async () => { void result.current.poll({ background: true }); });
    await act(async () => { void result.current.refresh(); });

    expect(runs.map(run => run.background)).toEqual([true, false]);
  });
});
