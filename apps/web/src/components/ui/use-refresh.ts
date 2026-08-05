import { useCallback, useEffect, useRef, useState } from 'react';

// `reload` must thread the signal into its calls and, after awaiting, return
// without writing state if it aborted. It also receives whether anybody asked
// for the run: a background run must not clear a failure nobody has read yet.
export interface RefreshControl {
  cancel: () => void;
  refresh: () => Promise<void>;
  poll: (options: { background: boolean }) => Promise<void>;
  refreshing: boolean;
}

export interface RefreshOnChangeControl<Query> extends RefreshControl {
  loadedQuery: Query;
}

export const useRefresh = (
  reload: (signal: AbortSignal, options: { background: boolean }) => Promise<void>,
): RefreshControl => {
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setRefreshing(false);
  }, []);

  const poll = useCallback(async ({ background }: { background: boolean }) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRefreshing(true);
    try {
      await reload(controller.signal, { background });
    } finally {
      // The flag belongs to the newest run: left set by a superseded one, the
      // control and every row action beside it stay disabled for good.
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setRefreshing(false);
      }
    }
  }, [reload]);

  const refresh = useCallback(() => poll({ background: false }), [poll]);

  return { cancel, poll, refresh, refreshing };
};

const sameQuery = <Query extends Record<string, unknown>>(left: Query, right: Query): boolean =>
  Object.keys(left).every(key => left[key] === right[key]);

/**
 * A page whose data is a function of a query refetches whenever the query
 * changes. The query is committed only when `reload` returns true, keeping the
 * controls and URL paired with the usable response on screen. A "have I
 * mounted yet" flag would make StrictMode's double invocation
 * indistinguishable from a real change and refetch on every visit; recording
 * the query at request time would strand a run torn down before it answered.
 *
 * `query` also carries the identity every run and the poll interval hang from,
 * so the caller holds it across the renders in which its fields do not change.
 */
export const useRefreshOnChange = <Query extends Record<string, unknown>>(
  query: Query,
  reload: (signal: AbortSignal, options: { background: boolean }) => Promise<boolean>,
  restore: (query: Query) => void,
): RefreshOnChangeControl<Query> => {
  const loadedFor = useRef(query);
  const [loadedQuery, setLoadedQuery] = useState(query);
  const control = useRefresh(useCallback(async (signal: AbortSignal, options: { background: boolean }) => {
    const succeeded = await reload(signal, options);
    if (signal.aborted) return;
    if (!succeeded) {
      restore(loadedFor.current);
      return;
    }
    loadedFor.current = query;
    setLoadedQuery(query);
  }, [query, reload, restore]));
  const { cancel, refresh } = control;

  useEffect(() => {
    if (sameQuery(loadedFor.current, query)) {
      cancel();
      return;
    }
    void refresh();
  }, [cancel, query, refresh]);

  return { ...control, loadedQuery };
};
