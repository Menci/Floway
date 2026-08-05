import { useCallback } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, test, vi } from 'vitest';

import { useRefresh, useRefreshOnChange } from '../../../src/components/ui/use-refresh';

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

test('query-driven refresh commits the query only when its response arrives', async () => {
  const runs: Array<{ settle: (succeeded: boolean) => void }> = [];
  const reload = (_signal: AbortSignal, _options: { background: boolean; requestedAt: number }) =>
    new Promise<boolean>(resolve => { runs.push({ settle: resolve }); });
  const restore = vi.fn();
  const onCommit = vi.fn();
  const { result, rerender } = renderHook(
    ({ query }) => useRefreshOnChange(query, 100, reload, restore, onCommit),
    { initialProps: { query: { groupBy: 'model' } } },
  );

  rerender({ query: { groupBy: 'upstream' } });
  await waitFor(() => expect(runs).toHaveLength(1));
  expect(result.current.loadedQuery).toEqual({ groupBy: 'model' });

  await act(async () => {
    runs[0]!.settle(true);
  });
  expect(result.current.loadedQuery).toEqual({ groupBy: 'upstream' });
  expect(result.current.loadedAt).toBeGreaterThan(100);
  expect(onCommit).toHaveBeenCalledWith({ groupBy: 'model' }, { groupBy: 'upstream' });
});

test('query-driven refresh keeps the displayed query after a failed response', async () => {
  const runs: Array<{ settle: (succeeded: boolean) => void }> = [];
  const reload = (_signal: AbortSignal, _options: { background: boolean; requestedAt: number }) =>
    new Promise<boolean>(resolve => { runs.push({ settle: resolve }); });
  const restore = vi.fn();
  const { result, rerender } = renderHook(
    ({ query }) => useRefreshOnChange(query, 100, reload, restore),
    { initialProps: { query: { groupBy: 'model' } } },
  );

  rerender({ query: { groupBy: 'upstream' } });
  await waitFor(() => expect(runs).toHaveLength(1));
  await act(async () => { runs[0]!.settle(false); });

  expect(result.current.loadedQuery).toEqual({ groupBy: 'model' });
  expect(result.current.loadedAt).toBe(100);
  expect(restore).toHaveBeenCalledWith({ groupBy: 'model' });

  await act(async () => { void result.current.refresh(); });
  expect(runs).toHaveLength(2);
});

test.each(['superseded-first', 'newest-first'] as const)(
  'query-driven refresh commits only the newest response when requests settle %s',
  async (settlementOrder) => {
    const runs: Array<{
      query: { groupBy: string };
      requestedAt: number;
      settle: (succeeded: boolean) => void;
      signal: AbortSignal;
    }> = [];
    const responses: string[] = [];
    const restore = vi.fn();
    const onCommit = vi.fn();
    const { result, rerender } = renderHook(
      ({ query }) => {
        const reload = useCallback(async (signal: AbortSignal, { requestedAt }: { requestedAt: number }) => {
          const succeeded = await new Promise<boolean>(resolve => {
            runs.push({ query, requestedAt, settle: resolve, signal });
          });
          if (signal.aborted) return false;
          if (succeeded) responses.push(query.groupBy);
          return succeeded;
        }, [query]);
        return useRefreshOnChange(query, 100, reload, restore, onCommit);
      },
      { initialProps: { query: { groupBy: 'model' } } },
    );

    rerender({ query: { groupBy: 'upstream' } });
    await waitFor(() => expect(runs).toHaveLength(1));
    rerender({ query: { groupBy: 'keyId' } });
    await waitFor(() => expect(runs).toHaveLength(2));

    expect(runs[0]!.signal.aborted).toBe(true);
    expect(runs[1]!.signal.aborted).toBe(false);
    const first = settlementOrder === 'superseded-first' ? runs[0]! : runs[1]!;
    const second = settlementOrder === 'superseded-first' ? runs[1]! : runs[0]!;
    await act(async () => { first.settle(true); });

    if (settlementOrder === 'superseded-first') {
      expect(responses).toEqual([]);
      expect(result.current.loadedQuery).toEqual({ groupBy: 'model' });
      expect(result.current.loadedAt).toBe(100);
      expect(onCommit).not.toHaveBeenCalled();
    }

    await act(async () => { second.settle(true); });

    expect(responses).toEqual(['keyId']);
    expect(result.current.loadedQuery).toEqual({ groupBy: 'keyId' });
    expect(result.current.loadedAt).toBe(runs[1]!.requestedAt);
    expect(restore).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ groupBy: 'model' }, { groupBy: 'keyId' });
  },
);
